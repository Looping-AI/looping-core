import { and, eq, inArray, lt, max } from "drizzle-orm";
import { z } from "zod";
import { subtasks } from "../schema.js";
import type { DB } from "../db.js";
import type {
  Subtask,
  SubtaskDraft,
  SubtaskId,
  SubtaskReference,
  SubtaskResultPart,
  SubtaskStatus
} from "../../subtasks/types.js";

const referenceSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string()
});

const resultPartSchema = z.object({
  kind: z.literal("text"),
  text: z.string()
});

const referencesSchema = z.array(referenceSchema);
const resultPartsSchema = z.array(resultPartSchema);
const dependsOnSchema = z.array(z.number().int());
const paramsSchema = z.record(z.string(), z.string());

type SubtaskRow = typeof subtasks.$inferSelect;

export interface SubtaskModelOptions {
  /**
   * Upper bound on subtasks per round, re-checked here as the **durable** guard.
   * The delegation schema offers the model the same bound, but a schema is a
   * suggestion to a model and this is the write that has to hold.
   */
  maxSubtasks: number;
}

/**
 * Query methods for the `subtasks` table (durable decomposed units of work).
 *
 * Bound to a drizzle handle by {@link AgentDB} and reached as `db.subtasks.*`.
 * durable-sqlite is synchronous; the multi-statement `createDecomposition` runs
 * inside an explicit `db.transaction` (drizzle maps it to
 * `storage.transactionSync`), so a mid-create failure rolls back every statement
 * instead of leaving a partial DAG. Guarded transitions filter on the expected
 * current `status`, so a disallowed transition matches no row and is a no-op.
 */
export function makeSubtasks(db: DB, opts: SubtaskModelOptions) {
  const rowToSubtask = (row: SubtaskRow): Subtask => ({
    id: row.id,
    taskId: row.taskId,
    round: row.round,
    ordinal: row.ordinal,
    type: row.type,
    recipeId: row.recipeId,
    recipeVersion: row.recipeVersion,
    prompt: row.prompt,
    references: referencesSchema.parse(
      JSON.parse(row.referencesJson)
    ) as SubtaskReference[],
    dependsOn: dependsOnSchema.parse(JSON.parse(row.dependsOnJson)),
    params: paramsSchema.parse(JSON.parse(row.paramsJson)),
    status: row.status as SubtaskStatus,
    resultParts:
      row.resultPartsJson === null
        ? null
        : (resultPartsSchema.parse(
            JSON.parse(row.resultPartsJson)
          ) as SubtaskResultPart[]),
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt
  });

  const list = (taskId: string): Subtask[] =>
    db
      .select()
      .from(subtasks)
      .where(eq(subtasks.taskId, taskId))
      .orderBy(subtasks.ordinal)
      .all()
      .map(rowToSubtask);

  /** Rides `idx_subtasks_task_round` — no full-Task scan to reach one round. */
  const listRound = (taskId: string, round: number): Subtask[] =>
    db
      .select()
      .from(subtasks)
      .where(and(eq(subtasks.taskId, taskId), eq(subtasks.round, round)))
      .orderBy(subtasks.ordinal)
      .all()
      .map(rowToSubtask);

  /** Guarded status update: applies only from a `from` status, returns whether it did. */
  const transition = (
    id: SubtaskId,
    from: SubtaskStatus | SubtaskStatus[],
    set: Partial<SubtaskRow>
  ): boolean => {
    const now = Date.now();
    const statuses = Array.isArray(from) ? from : [from];
    const updated = db
      .update(subtasks)
      .set({ ...set, updatedAt: now })
      .where(and(eq(subtasks.id, id), inArray(subtasks.status, statuses)))
      .returning({ id: subtasks.id })
      .all();
    return updated.length > 0;
  };

  return {
    /**
     * Create one **round's** decomposition atomically: the entire
     * check-validate-insert sequence runs in one synchronous `db.transaction`, so
     * a failure anywhere rolls back every statement — no truncated subtask set, no
     * nodes left with unwritten dependency edges. Idempotent on
     * `(taskId, round)`: if this round already has Subtasks, returns them
     * unchanged (a Workflow-step retry must not duplicate work); the unique
     * `(task_id, ordinal)` index is the schema-level backstop. Enforces the 1..8
     * per-round bound, unique local keys, and resolvable non-self dependency
     * edges, then resolves draft-local dependency keys to the SQLite-assigned
     * {@link SubtaskId}s. Full cycle/edge DAG validation lives in the turn
     * operation; this is the storage guard.
     *
     * `ordinal` continues across rounds (it is the Task-wide position, and what
     * the unique index is built on), so a later round's rows sort after the
     * earlier ones in {@link list}. Dependency edges never cross a round: each
     * round's DAG is self-contained, and the drafts handed here only carry keys
     * from their own round.
     */
    createDecomposition(
      taskId: string,
      round: number,
      drafts: SubtaskDraft[]
    ): Subtask[] {
      return db.transaction(() => {
        const existing = listRound(taskId, round);
        if (existing.length > 0) return existing;

        if (drafts.length < 1 || drafts.length > opts.maxSubtasks) {
          throw new Error(
            `decomposition must have 1..${opts.maxSubtasks} subtasks, got ${drafts.length}`
          );
        }

        // Register every local key first, rejecting duplicates. This is its own
        // pass because the dependency check below reads the complete key set: an
        // edge may point forward to a draft defined later, so every key must be
        // known before any edge is validated.
        const keys = new Set<string>();
        for (const d of drafts) {
          if (keys.has(d.localKey)) {
            throw new Error(`duplicate draft local key: ${d.localKey}`);
          }
          keys.add(d.localKey);
        }

        for (const d of drafts) {
          for (const dep of d.dependsOn) {
            // A subtask cannot depend on itself.
            if (dep === d.localKey) {
              throw new Error(`subtask ${d.localKey} depends on itself`);
            }
            // Every edge must resolve to a key in this decomposition.
            if (!keys.has(dep)) {
              throw new Error(
                `subtask ${d.localKey} depends on unknown key: ${dep}`
              );
            }
          }
          // References must match the persisted shape before we serialize them.
          referencesSchema.parse(d.references);
        }

        const now = Date.now();
        const keyToId = new Map<string, SubtaskId>();

        // Pass 1: insert nodes (deps empty for now) to assign ids. Ordinals
        // continue above every earlier round's rows — from the current maximum,
        // not a row count, so a gap left by {@link cleanup} deleting part of a
        // Task cannot hand a later round an ordinal that is already taken. Both
        // read the `(task_id, ordinal)` index; only this one stays monotonic.
        const highest =
          db
            .select({ max: max(subtasks.ordinal) })
            .from(subtasks)
            .where(eq(subtasks.taskId, taskId))
            .get()?.max ?? null;
        const firstOrdinal = highest === null ? 0 : highest + 1;
        drafts.forEach((d, offset) => {
          const { id } = db
            .insert(subtasks)
            .values({
              taskId,
              round,
              ordinal: firstOrdinal + offset,
              type: d.type,
              recipeId: null,
              recipeVersion: null,
              prompt: d.prompt,
              referencesJson: JSON.stringify(d.references),
              dependsOnJson: "[]",
              paramsJson: JSON.stringify(d.params ?? {}),
              status: "pending" satisfies SubtaskStatus,
              resultPartsJson: null,
              error: null,
              createdAt: now,
              updatedAt: now,
              completedAt: null
            })
            .returning({ id: subtasks.id })
            .get();
          keyToId.set(d.localKey, id);
        });

        // Pass 2: rewrite dependency edges to real ids.
        for (const d of drafts) {
          if (d.dependsOn.length === 0) continue;
          const ids = d.dependsOn.map((k) => keyToId.get(k) as SubtaskId);
          db.update(subtasks)
            .set({ dependsOnJson: JSON.stringify(ids) })
            .where(eq(subtasks.id, keyToId.get(d.localKey) as SubtaskId))
            .run();
        }

        return listRound(taskId, round);
      });
    },

    /** Load one Subtask by id. */
    get(id: SubtaskId): Subtask | null {
      const row = db.select().from(subtasks).where(eq(subtasks.id, id)).get();
      return row ? rowToSubtask(row) : null;
    },

    /** List every round's Subtasks for a Task, in ordinal order. */
    list(taskId: string): Subtask[] {
      return list(taskId);
    },

    /**
     * List one round's Subtasks, in ordinal order — the scheduler's view. Phase 2
     * drives a single round's DAG at a time, so it must not see a sibling round's
     * rows; composition, by contrast, reads {@link list} across all rounds.
     */
    listRound(taskId: string, round: number): Subtask[] {
      return listRound(taskId, round);
    },

    /**
     * Begin execution: guarded `pending -> running`, recording the resolved
     * Recipe id/version after-the-fact. Returns false if the Subtask was not
     * pending (already started, terminal, or unknown).
     */
    start(
      id: SubtaskId,
      recipe: { recipeId: string; recipeVersion: number }
    ): boolean {
      return transition(id, "pending", {
        status: "running",
        recipeId: recipe.recipeId,
        recipeVersion: recipe.recipeVersion
      });
    },

    /**
     * Persist a successful terminal result: guarded `running -> completed`.
     * Requires at least one non-empty text result part (a successful Recipe
     * output invariant).
     */
    complete(id: SubtaskId, resultParts: SubtaskResultPart[]): boolean {
      const parts = resultPartsSchema.parse(resultParts);
      if (!parts.some((p) => p.text.trim().length > 0)) {
        throw new Error("completed subtask requires a non-empty text part");
      }
      return transition(id, "running", {
        status: "completed",
        resultPartsJson: JSON.stringify(parts),
        completedAt: Date.now()
      });
    },

    /**
     * Persist a failure from either non-terminal status, with a diagnostic message.
     *
     * Both sides are reachable and both must land. A child's failed result arrives
     * on a `running` row. The Workflow's last resort — `failSubtask`, once
     * `execute:<id>` has exhausted every retry — can arrive on either:
     * `executeSubtask` may throw before its `pending -> running` claim (a
     * dependency-invariant fault) or after it (a transient child fault). Leaving
     * either behind strands the row: a `pending` node re-enters the next wave
     * forever, and a `running` node blocks its dependents, which {@link skip} only
     * propagates past *failed* prerequisites.
     *
     * Returns false once the row is terminal — a late loser to the real result.
     */
    fail(id: SubtaskId, error: string): boolean {
      return transition(id, ["running", "pending"], {
        status: "failed",
        error,
        completedAt: Date.now()
      });
    },

    /** Skip a Subtask blocked by a failed/skipped dependency: guarded `pending -> skipped`. */
    skip(id: SubtaskId): boolean {
      return transition(id, "pending", { status: "skipped" });
    },

    /**
     * Discard a late result after parent cancellation: guarded
     * `running -> canceled`. The parent calls this when a child returned a
     * terminal result but the Task was canceled while it ran — the result is
     * dropped, and this leaves the row in a truthful terminal state instead of a
     * `running` that never resolves. Returns false if the Subtask was not running.
     */
    cancelRunning(id: SubtaskId): boolean {
      return transition(id, "running", {
        status: "canceled",
        completedAt: Date.now()
      });
    },

    /**
     * Cancel every still-pending Subtask of a Task (parent cancellation).
     * Running Subtasks are left alone here — the parent transitions those with
     * {@link cancelRunning} once their in-flight result comes back and is
     * discarded. Returns the number canceled.
     */
    cancelPending(taskId: string): number {
      const now = Date.now();
      const canceled = db
        .update(subtasks)
        .set({ status: "canceled", updatedAt: now })
        .where(and(eq(subtasks.taskId, taskId), eq(subtasks.status, "pending")))
        .returning({ id: subtasks.id })
        .all();
      return canceled.length;
    },

    /** Delete Subtasks older than 30 days (called by the weekly maintenance cron). */
    cleanup(): void {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      db.delete(subtasks).where(lt(subtasks.createdAt, cutoff)).run();
    }
  };
}
