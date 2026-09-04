import type { FinishReason, StepResult, ToolSet } from "ai";
import { APICallError, RetryError } from "ai";
// Type-only would not work: this is a runtime guard. `errors.ts` is the neutral
// sibling of `model.ts` and imports nothing, so this reaches no provider.
import { CredentialRejectedError } from "./errors.js";

/**
 * Shared Workers-AI plumbing for the agent's inference operations — the pieces
 * every model call needs regardless of *which* operation it belongs to.
 *
 * The two loops themselves are deliberately separate, not layered on a common
 * one: the main agent's Session-coupled round lives in
 * {@link file://../round/turn.ts turn.ts}, and the Session-less subagent loop in
 * {@link file://../subagent/run.ts run.ts}. They share error classification and
 * progress streaming; their control flow has nothing in common worth abstracting.
 */

/**
 * Called with each **intermediate** assistant content message — text the model
 * emits in a step that also makes tool calls (`finishReason:"tool-calls"`), i.e.
 * before the final reply. Used to stream those messages out live; the final reply
 * is the operation's return value, not an `onContent` call. `stepIndex` is the
 * 0-based step ordinal (stable enough across a primary→fallback re-run for the
 * gatekeeper to dedupe on). Best-effort — the caller must swallow its own failures.
 */
export type OnContent = (
  text: string,
  stepIndex: number
) => void | Promise<void>;

/** Workers-AI error codes and message fragments that mean "try again later". */
const TRANSIENT_MESSAGE_FRAGMENTS = [
  "3040",
  "3046",
  "capacity temporarily exceeded",
  "request timeout",
  "rate limit",
  "too many requests",
  "overloaded",
  "service unavailable"
];

/** HTTP statuses worth another attempt: timeout, conflict, throttle, any 5xx. */
function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Whether an error is a transient availability condition rather than a
 * deterministic bad-output one.
 *
 * The distinction decides who handles it: transient throws out of the attempt loop
 * so the Workflow step retries the whole round, while everything else burns the
 * model slot and hands over to the fallback. Classifying a capacity blip as
 * deterministic is the expensive mistake — it spends both slots on an outage and
 * fails a Task that would have succeeded a second later.
 *
 * Structured signals first: the SDK's own `APICallError.isRetryable`, then the
 * status code, then `RetryError` (raised once the SDK's internal backoff is
 * exhausted). The message fragments stay as the last resort for the Workers-AI
 * error codes, which arrive as prose on a plain `Error`.
 */
export function isTransientAiError(err: unknown): boolean {
  // Checked first because a rejected credential's message can carry "rate
  // limit"-adjacent prose the fragment scan below would misread as transient.
  // Note that `false` alone does not protect the fallback slot — see
  // {@link nonRecoverableKind}, which is what actually stops the ladder.
  if (nonRecoverableKind(err) !== undefined) return false;
  if (APICallError.isInstance(err)) {
    if (err.isRetryable) return true;
    if (isRetryableStatus(err.statusCode)) return true;
  }
  if (RetryError.isInstance(err)) return true;
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return TRANSIENT_MESSAGE_FRAGMENTS.some((fragment) =>
    message.includes(fragment)
  );
}

/**
 * Why a round stopped without a second attempt being worth making.
 *
 * A stable string rather than the error itself, because this value crosses two
 * serialization boundaries — the DO's RPC return and a Workflow step result —
 * and an `Error` survives neither reliably. The host maps it to operator-facing
 * copy; core never owns that wording.
 *
 * The credential kinds are separate strings rather than one, because they have
 * different remedies and the host cannot tell them apart afterwards:
 *
 * - `credential` — the model provider rejected the token. Rotate that one.
 * - `gateway-credential` — the AI Gateway *in front of* the provider rejected the
 *   request, which the provider therefore never saw. Rotate the AI Gateway token
 *   (`cf-aig-authorization`) instead; the model credential is very likely fine.
 * - `unknown-credential` — a `401`/`403` matching none of the shapes. Says so,
 *   rather than picking one and sending an operator to rotate a working secret.
 *
 * A fourth, `proxy-credential`, was removed in 0.8.0 along with
 * {@link file://./errors.ts CredentialRejectedBy}'s `"proxy"` arm. Adding a kind
 * back is a breaking change for every consumer, because the `Record` they map it
 * with is total — which is the property that makes a new kind impossible to
 * ignore, and the reason to remove one rather than leave it unreachable.
 */
export type NonRecoverableKind =
  "credential" | "gateway-credential" | "unknown-credential";

/**
 * Why a round ended with no answer — one terminal status, two situations.
 *
 * `exhausted` is the ladder run to the end: both slots tried, every repair
 * spent, nothing usable produced. Every other member is the ladder stopping
 * early, because nothing further could have cleared the fault — see
 * {@link nonRecoverableKind}.
 *
 * The distinction is a *reason*, not an outcome: both deliver a failed Task with
 * the same shape. What it decides is the words, and only the host has those (see
 * `HandleTaskDeps.failureCopy`) — which is why this is a total union rather than
 * an optional field. A consumer that maps kinds to copy is then a `Record` the
 * compiler checks, and a new kind cannot be silently ignored by any of them.
 */
export type RoundFailureKind = "exhausted" | NonRecoverableKind;

/**
 * Whether an error is one that **no** further attempt can clear, and the reason.
 *
 * This is the third classification, and the one the other two cannot express.
 * {@link isTransientAiError} splits failures into "retry the step" (`true`) and
 * "burn this slot, try the fallback" (`false`) — and for a rejected credential
 * *both* are wrong. Retrying spends the Workflow's budget on a request that can
 * never succeed; falling back spends the second slot presenting the *same* dead
 * token. Returning `false` from the transient check only avoids the first.
 *
 * So the attempt ladders check this **before** entering the fallback slot and
 * stop there, and `runHandleTask` ends the Task with copy the host supplies.
 * Nothing is retried and nothing is spent proving the obvious twice.
 *
 * Keyed on {@link file://./errors.ts CredentialRejectedError}, which is neutral
 * and structurally matched — so a provider outside core raises one and gets this
 * handling with nothing here to change.
 */
export function nonRecoverableKind(
  err: unknown
): NonRecoverableKind | undefined {
  if (!CredentialRejectedError.isInstance(err)) return undefined;
  switch (err.source) {
    case "provider":
      return "credential";
    case "gateway":
      return "gateway-credential";
    // Includes an error that crossed a realm boundary carrying no `source` at
    // all: `isInstance` is structural, so that is reachable, and "unknown" is
    // the honest reading of it.
    default:
      return "unknown-credential";
  }
}

/** A step is "intermediate" when it makes tool calls — more content follows. */
function isIntermediateStep(step: { finishReason: FinishReason }): boolean {
  return step.finishReason === "tool-calls";
}

/**
 * Returns a fresh `onStepEnd` callback for one `generateText` attempt.
 * Fires `onContent` for each intermediate step (text that accompanies tool
 * calls); the final step is skipped because its text is the operation's return
 * value. A fresh handler per attempt resets the 0-based `stepIndex` counter so a
 * primary→fallback re-run reuses the same indices and the gatekeeper dedupes.
 *
 * `terminalToolNames` are the loop's **halting** control tools (e.g. the main
 * agent's `delegate`): a step that calls one still has `finishReason:"tool-calls"`,
 * but it is the round's *final* step, and its accompanying text is the round's
 * acknowledgment — which the caller publishes separately as a milestone. Streaming
 * it here too would double-post the same text under a second messageId, so those
 * steps are skipped. Default `[]` (the subagent loop has no control tools).
 */
export function buildIntermediateContentHandler(
  onContent: OnContent,
  terminalToolNames: string[] = []
): (step: StepResult<ToolSet>) => Promise<void> {
  let stepIndex = 0;
  return async (step) => {
    const i = stepIndex++;
    if (!isIntermediateStep(step)) return;
    if (step.toolCalls.some((c) => terminalToolNames.includes(c.toolName)))
      return;
    const content = step.text.trim();
    if (content) await onContent(content, i);
  };
}
