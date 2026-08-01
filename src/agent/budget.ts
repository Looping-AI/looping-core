/**
 * One round's turn allowance, carried as a single mutable object rather than as a
 * number threaded down and a count threaded back up.
 *
 * The distinction matters because a round is not one model call. Each slot may
 * repair a rejected decomposition several times before the round moves on to the
 * fallback, and every one of those attempts *restarts* the round from the same
 * messages — so a failed attempt is work redone, with whatever tool side effects
 * it already had. They all spend the same allowance. When that allowance was a
 * plain number, keeping later attempts honest meant remembering to decrement it
 * between each pair, and forgetting let one round cost a multiple of its budget.
 * Sharing one object removes the thing there was to forget.
 *
 * `spent` is mutated where the turn is actually spent (the model loop's
 * `onStepEnd`) and read where it actually matters (the RPC return that the
 * Workflow meters against the Task). Nothing in between carries it.
 */

/** One round's allowance and what it has spent, across every attempt in the round. */
export interface TurnBudget {
  /** What this round was allowed when it started: the Task's unspent turns. */
  readonly allowance: number;
  /** Turns spent so far. Mutated by the model loop, one per completed step. */
  spent: number;
}

/** A fresh budget for a round that may spend `allowance` turns. */
export const newTurnBudget = (allowance: number): TurnBudget => ({
  allowance,
  spent: 0
});

/**
 * Steps one `generateText` attempt may spend, given what the run has already used.
 *
 * Must be evaluated **per attempt**: `isStepCount` counts steps within a single
 * call, so an allowance computed once and shared with later attempts would hand
 * each of them the turns its predecessors already burned.
 *
 * The `Math.max(1, …)` floor is load-bearing, not defensive. A primary that
 * consumed the entire remainder still leaves the fallback one step, because an
 * attempt with nothing to spend cannot reach an ending — which fails the round and
 * costs the caller its answer, a far worse trade than one turn. So a round may
 * exceed its allowance by exactly one, and never by more.
 *
 * The bound survives repair attempts because only an attempt that *starts* already
 * at the allowance can overrun, and only by the one step of this floor: an attempt
 * that starts under it is capped at the exact remainder, and `runTurn` refuses to
 * open a repair once the allowance is gone. That leaves the fallback's first
 * attempt as the only one that can ever begin overdrawn.
 */
export const stepAllowance = (maxTurns: number, spent: number): number =>
  Math.max(1, maxTurns - spent);
