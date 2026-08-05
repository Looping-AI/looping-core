import { Task, TaskState } from "@a2a-js/sdk";
import { and, count, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import { taskStateLabel, type PlainTask } from "../../a2a/task.js";
import { buildSubmittedTask } from "../../a2a/notify.js";
import { notifyTasks } from "../schema.js";
import type { DB } from "../db.js";

function nowIso(): string {
  return new Date().toISOString();
}

/** Filters + paging for {@link makeTasks} `list` (the A2A `ListTasks` method). */
export interface TaskListQuery {
  /** A2A context id to filter on; empty/absent means no filter. */
  contextId?: string;
  /** Task state to filter on, or `undefined` for any state. */
  state?: TaskState;
  /** Only tasks whose status was written at or after this epoch-ms instant. */
  updatedAfter?: number;
  /** Drop `artifacts` from the returned tasks (the spec's default). */
  includeArtifacts: boolean;
  /** Cap on each task's `history`; `undefined` keeps it whole, `0` drops it. */
  historyLength?: number;
  limit: number;
  offset: number;
}

/**
 * A task's state, tolerating the `status`-less task the SDK's generated type
 * permits (`TaskStatus | undefined`). Nothing we build omits it, so an
 * unspecified state means the row came from somewhere unexpected — and it
 * compares equal to none of the states the callers switch on.
 */
export function stateOf(task: Task): TaskState {
  return task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
}

/**
 * Query methods for the `notify_tasks` table (async A2A task state).
 *
 * Bound to a drizzle handle by {@link AgentDB} and reached as `db.tasks.*`.
 * Migrations are owned by `AgentDB`, not this factory — it only issues queries.
 *
 * Rows hold the task in its **A2A wire form** (`Task.toJSON`), not the in-memory
 * protobuf shape the SDK hands us. Those differ under v1.0 — enums are numbers
 * in memory but `SCREAMING_SNAKE` strings on the wire, and `Part.content` is a
 * `{ $case, value }` wrapper in memory but a bare named key on the wire — so a
 * plain `JSON.stringify` would persist a shape that is neither valid A2A JSON
 * nor stable across SDK versions. Encoding on write and decoding on read keeps
 * the stored bytes the spec's own format, which is also exactly what
 * `postNotification` puts on the wire.
 */
export function makeTasks(db: DB) {
  // Every row was written by the builders in `a2a/notify`, which produce exactly
  // the narrowed {@link PlainTask} shape, so the decode lands back on it.
  const parse = (row: { taskJson: string }): PlainTask =>
    Task.fromJSON(JSON.parse(row.taskJson)) as PlainTask;

  const serialize = (task: Task): string => JSON.stringify(Task.toJSON(task));

  const readOne = (taskId: string): PlainTask | null => {
    const row = db
      .select()
      .from(notifyTasks)
      .where(eq(notifyTasks.taskId, taskId))
      .get();
    return row ? parse(row) : null;
  };

  const upsert = (task: Task): void => {
    const now = Date.now();
    // Denormalized so `ListTasks` can filter on it without decoding every blob.
    const columns = {
      contextId: task.contextId,
      state: taskStateLabel(stateOf(task)),
      taskJson: serialize(task),
      updatedAt: now
    };
    db.insert(notifyTasks)
      .values({ taskId: task.id, messageId: null, createdAt: now, ...columns })
      .onConflictDoUpdate({ target: notifyTasks.taskId, set: columns })
      .run();
  };

  return {
    /**
     * Accept a turn: return the `submitted` task for the given `messageId`,
     * creating it on first sight. Idempotent on `messageId` (the gateway's
     * dedupe key, stable across dispatch retries).
     */
    begin(input: {
      messageId: string;
      taskId: string;
      contextId: string;
    }): PlainTask {
      const existing = db
        .select()
        .from(notifyTasks)
        .where(eq(notifyTasks.messageId, input.messageId))
        .get();
      if (existing) return parse(existing);

      const task = buildSubmittedTask(input.taskId, input.contextId);
      const now = Date.now();
      db.insert(notifyTasks)
        .values({
          taskId: task.id,
          messageId: input.messageId,
          contextId: task.contextId,
          state: taskStateLabel(task.status.state),
          taskJson: serialize(task),
          createdAt: now,
          updatedAt: now
        })
        .run();
      return task;
    },

    /** Load a task by id (for `GetTask` via the Worker's `DurableTaskStore`). */
    get(taskId: string): PlainTask | null {
      return readOne(taskId);
    },

    /**
     * A page of this caller's tasks for `ListTasks`, newest first, with the
     * total matching count so the store can decide whether a next page exists.
     */
    list(query: TaskListQuery): { tasks: PlainTask[]; totalSize: number } {
      const filters: SQL[] = [];
      if (query.contextId) {
        filters.push(eq(notifyTasks.contextId, query.contextId));
      }
      if (query.state !== undefined) {
        filters.push(eq(notifyTasks.state, taskStateLabel(query.state)));
      }
      if (query.updatedAfter !== undefined) {
        filters.push(gte(notifyTasks.updatedAt, query.updatedAfter));
      }
      const where = filters.length > 0 ? and(...filters) : undefined;

      const rows = db
        .select()
        .from(notifyTasks)
        .where(where)
        .orderBy(desc(notifyTasks.createdAt))
        .limit(query.limit)
        .offset(query.offset)
        .all();
      const total = db
        .select({ value: count() })
        .from(notifyTasks)
        .where(where)
        .get();

      return {
        tasks: rows.map((row) => project(parse(row), query)),
        totalSize: total?.value ?? 0
      };
    },

    /**
     * Upsert a task by id, preserving the `message_id` set by {@link begin}.
     * Returns whether the write applied.
     *
     * Guarded exactly like {@link markWorking}, and for the same reason: a
     * `canceled` row is terminal, so nothing may write a non-canceled state over
     * it. That closes the window between a workflow's terminal build and its
     * callback — the read-check-write is synchronous here, so a `CancelTask`
     * landing mid-delivery makes this return `false` and the notify never fires.
     *
     * The reverse direction is guarded too: writing `canceled` over an already
     * `completed`/`failed` row is refused, mirroring {@link cancel}'s own source
     * guard. Without it, a cancellation landing between the Workflow's `complete`
     * and `notify` steps — separate, independently-retried steps — could flip
     * storage to canceled while `deliver()` still posts the cached completed
     * task it already built, the exact race this guard exists to close. Writing
     * `canceled` onto a `submitted`/`working` row, or re-writing it onto an
     * already-`canceled` one, stays allowed: that is how the a2a-js handler's own
     * cancel branch records the cancellation.
     */
    save(task: Task): boolean {
      const existing = readOne(task.id);
      if (existing === null) {
        upsert(task);
        return true;
      }
      const existingState = stateOf(existing);
      const incomingState = stateOf(task);
      if (
        existingState === TaskState.TASK_STATE_CANCELED &&
        incomingState !== TaskState.TASK_STATE_CANCELED
      ) {
        return false;
      }
      if (
        incomingState === TaskState.TASK_STATE_CANCELED &&
        existingState !== TaskState.TASK_STATE_SUBMITTED &&
        existingState !== TaskState.TASK_STATE_WORKING &&
        existingState !== TaskState.TASK_STATE_CANCELED
      ) {
        return false;
      }
      upsert(task);
      return true;
    },

    /**
     * Move a task to `working` (a turn workflow's first step). Returns
     * `"canceled"` when the row is already canceled, which is the caller's
     * signal to stop the turn; every other outcome — unknown task, or a task
     * already past `submitted` — is a no-op reported as `"ok"`, because a
     * workflow replay legitimately re-runs this step.
     */
    markWorking(taskId: string): "ok" | "canceled" {
      const task = readOne(taskId);
      if (!task) return "ok";
      if (stateOf(task) === TaskState.TASK_STATE_CANCELED) return "canceled";
      if (stateOf(task) !== TaskState.TASK_STATE_SUBMITTED) return "ok";
      task.status = {
        ...task.status,
        state: TaskState.TASK_STATE_WORKING,
        message: task.status?.message,
        timestamp: nowIso()
      };
      upsert(task);
      return "ok";
    },

    /**
     * Flip the task to `canceled` and return it, or `null` if the row is not
     * eligible — unknown, or already past `submitted`/`working`. Guarding the
     * source state (not just the destination, as {@link save} does) matters
     * because `complete`/`notify` are separate Workflow steps: without this, a
     * cancellation landing between them would flip an already-`completed` or
     * `failed` row to `canceled` right as `deliver()` posts the terminal
     * callback it had already built, silently rewriting a delivered result.
     * Terminal: once this lands, {@link save} refuses every non-canceled write,
     * so no completed or failed callback can be built from this row afterwards.
     */
    cancel(taskId: string): PlainTask | null {
      const task = readOne(taskId);
      if (!task) return null;
      const state = stateOf(task);
      if (
        state !== TaskState.TASK_STATE_SUBMITTED &&
        state !== TaskState.TASK_STATE_WORKING
      ) {
        return null;
      }
      task.status = {
        ...task.status,
        state: TaskState.TASK_STATE_CANCELED,
        message: task.status?.message,
        timestamp: nowIso()
      };
      upsert(task);
      return task;
    },

    /** Delete all tasks older than 30 days (called by the maintenance cron). */
    cleanup(): void {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      db.delete(notifyTasks).where(lt(notifyTasks.createdAt, cutoff)).run();
    }
  };
}

/**
 * Apply the `ListTasks` response-shaping options to one stored task. Rows are
 * JSON blobs, so the repeated fields are defaulted rather than assumed present.
 */
function project(task: PlainTask, query: TaskListQuery): PlainTask {
  const history = task.history ?? [];
  return {
    ...task,
    artifacts: query.includeArtifacts ? (task.artifacts ?? []) : [],
    history:
      query.historyLength === undefined
        ? history
        : history.slice(Math.max(0, history.length - query.historyLength))
  };
}
