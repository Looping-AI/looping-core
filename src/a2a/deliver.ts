import type { WorkflowStep } from "cloudflare:workers";
import { createPushChannel, type TurnPushContext } from "./push.js";
import type { PlainTask } from "./task.js";

/** What {@link deliverTerminalTask} needs to finish a turn. */
export interface DeliverTerminalOptions {
  /** Which Task this is about, and where its callback goes. */
  push: TurnPushContext;
  /** The agent's card-signing key, for the callback JWT. */
  signingKey: string;
  /**
   * The guarded write, and **the cancellation check**. Return whether it
   * applied: `false` must mean the row was already terminal (canceled), which is
   * what suppresses the callback.
   *
   * Resolve any Durable Object stub *inside* this function, never above it — a
   * stub hoisted out of a step body is a live connection that a replay cannot
   * reconnect.
   */
  saveTask: (task: PlainTask) => Promise<boolean>;
  /**
   * Build the terminal Task. Called **inside** the `complete` step so that what
   * gets notified is exactly what was persisted: building it outside would
   * re-stamp `new Date()` on every replay and post a Task that differs from the
   * stored one.
   */
  terminal: () => PlainTask;
  /**
   * Optional best-effort cleanup, run after the write and before the callback.
   * An agent with no managed children omits it and no `sweep` step appears.
   */
  sweep?: () => Promise<void>;
}

/**
 * Persist a turn's terminal Task, then notify the gateway.
 *
 * **The guarded write is the cancellation check.** `saveTask` refuses to write a
 * terminal state over a `canceled` row and says so, doing that read and write in
 * one synchronous pass inside the Durable Object. Probing first and saving
 * second would leave a window — between the two calls, and again between this
 * step and `notify` — in which a `tasks/cancel` lands and the gateway still
 * receives a `completed` callback. Keying the notify on "did the write apply"
 * closes it, and that has already been got wrong once.
 *
 * In `/a2a` rather than `/round` because the shape is not a round's: an agent
 * whose turn is a single inference ends it the same way, and importing this from
 * `/round` would put the whole delegation engine in a bundle that must not carry
 * it. Everything it calls already lives here.
 */
export async function deliverTerminalTask(
  step: WorkflowStep,
  options: DeliverTerminalOptions
): Promise<void> {
  const task = await step.do("complete", async () => {
    const terminal = options.terminal();
    return (await options.saveTask(terminal)) ? terminal : null;
  });
  if (!task) return;

  // Caught, not left to propagate: the terminal Task is already durably saved,
  // so a sweep that still fails once the step's own retries are exhausted must
  // not block the callback — the gateway is owed its result either way.
  if (options.sweep) {
    const sweep = options.sweep;
    try {
      await step.do("sweep", async () => {
        await sweep();
      });
    } catch (err) {
      console.error("[deliver] sweep failed after retries", {
        taskId: options.push.taskId,
        err: String(err)
      });
    }
  }

  // A card-key-signed callback POST. Retried by the step on a non-2xx; the
  // terminal messageId is deterministic and the gateway is idempotent and
  // single-use, so retries are safe. If it ultimately fails, the gateway's own
  // reaction backstop clears the pending marker.
  await step.do("notify", async () => {
    await createPushChannel(options.signingKey, options.push).deliver(task);
  });
}
