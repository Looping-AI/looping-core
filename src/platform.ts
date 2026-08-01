/**
 * What the Cloudflare Workflows runtime imposes, and the two numbers derived from
 * it. Nothing here is a budget or a preference — see {@link file://./config.ts}
 * for those, and note that no Recipe can reach these. They change when the
 * platform changes, and for no other reason.
 *
 * The distinction is worth keeping sharp, because collapsing it is what produced
 * the bug this file was extracted during: a *turn count* was used to keep a step
 * under the step timeout, which only works if you can predict how long a turn
 * takes. You cannot. Time bounds time here; turns bound cost, over in `config.ts`.
 */

/**
 * Platform fact: a `step.do(...)` callback is killed at ~10 minutes (Workflows'
 * default step timeout). {@link CHUNK_SOFT_MS} is sized against this.
 */
export const STEP_TIMEOUT_MS = 10 * 60_000;

/**
 * Platform fact: a single Workflow instance may run ~10,000 steps (paid plan).
 * {@link MAX_CHUNKS_PER_BRANCH} is sized against this — see the worst-case
 * product asserted in `test/agent/subtasks/subtask-types.spec.ts`.
 */
export const STEPS_PER_INSTANCE = 10_000;

/**
 * How long one durable chunk may run before it checkpoints and yields a fresh
 * step. Comfortably inside {@link STEP_TIMEOUT_MS} so a slow model turn in flight
 * when the soft limit trips still has room to finish.
 *
 * This is the *only* thing keeping a step under the timeout. A subagent otherwise
 * runs until its turn or wall-clock budget is spent, however many turns that takes
 * — which is the point: the runner no longer guesses at turn duration.
 */
export const CHUNK_SOFT_MS = 4 * 60_000;

/**
 * Hard ceiling on durable chunk steps for one Subtask branch. A backstop, not a
 * budget: the Workflow *fails* a branch that reaches it, so reaching it is a bug.
 * It is held unreachable by two constraints, both asserted in
 * `test/agent/subtasks/subtask-types.spec.ts`:
 *
 * 1. It exceeds every Recipe's `maxTurns`. A chunk that yields always advanced at
 *    least one turn, so a run takes at most `maxTurns` chunks however short they
 *    are — and they do get short, because `CHUNK_SOFT_MS` and progress events both
 *    end one early. That bound survives both; a nominal `maxTurns / turnsPerChunk`
 *    estimate survived neither, which is why no such estimate exists any more.
 * 2. The worst-case step product stays under {@link STEPS_PER_INSTANCE}.
 */
export const MAX_CHUNKS_PER_BRANCH = 40;
