/**
 * Failures the loops must treat specially, whichever provider raised them.
 *
 * A sibling of {@link file://./model.ts model.ts} and neutral for the same
 * reason: a provider directory may throw these, and nothing here may know that
 * any particular one exists. `nonRecoverableKind` in
 * {@link file://./inference.ts inference.ts} keys on this file, so a provider
 * written outside core — the thing `ModelRuntimeFactory` exists to make cheap —
 * gets the same handling as `agent/anthropic` with no change to core.
 *
 * ## Why a third classification was needed at all
 *
 * Core's attempt ladder splits every failure two ways — transient conditions
 * throw out so the Workflow step retries the whole round, everything else burns
 * the model slot and hands over to the fallback (see
 * {@link file://./inference.ts isTransientAiError}). An expired credential fits
 * neither: retrying spends the Workflow's budget on a request that can never
 * succeed, and falling back spends the second slot on the *same* rejected token.
 * It has to stop the round and say what a human must do.
 *
 * Note that being non-transient is not enough on its own — "not transient" is
 * precisely the signal that means "try the fallback".
 */

/**
 * Who refused the request, when a `401` came back.
 *
 * There can be up to three authorities on the path, each with its own
 * credential: the AI Gateway (`cf-aig-authorization`), an optional intermediary
 * a deployment puts between the gateway and the provider (`"proxy"`), and the
 * model provider itself (`Authorization`). They fail with the same status code
 * and completely different remedies, so a rejection that does not say which one
 * it was sends an operator to rotate the wrong secret — which is exactly what
 * happened before this existed.
 *
 * `"proxy"` is the odd one out: it is generally *not* a secret to rotate. An
 * intermediary that mints its caller credential per request fails for reasons
 * upstream of any stored secret — configuration drift, a rotated signing key,
 * clock skew — so the remedy is to look, not to rotate. Core recognises no
 * particular intermediary; a deployment that has one supplies its own classifier
 * (see `AnthropicModelDeps.classifyAuthFailure`).
 *
 * `"unknown"` is a real answer and the default. Guessing `"provider"` for an
 * unrecognised body is how the misdiagnosis happens; saying "one of these, here
 * is how to check each" is worse copy and better information.
 */
export type CredentialRejectedBy = "provider" | "gateway" | "proxy" | "unknown";

/**
 * A credential on the path to the model was rejected (HTTP 401 / 403).
 *
 * Deliberately not an `APICallError`: the AI SDK's classifier treats those as
 * potentially retryable, and this never is.
 * {@link file://./inference.ts nonRecoverableKind} maps it to one of the
 * credential kinds — which one depends on {@link source} — and that is what
 * stops the round before the fallback slot; `isTransientAiError` additionally
 * returns `false` so the message text can never be mistaken for a rate limit.
 *
 * The round then fails carrying that kind, and the host supplies the
 * operator-facing copy through `HandleTaskDeps.failureCopy` — core owns the
 * signal and the delivery, never the wording.
 */
export class CredentialRejectedError extends Error {
  readonly name = "CredentialRejectedError";
  /** The upstream status, when one was available. */
  readonly status: number | undefined;
  /** Which authority rejected it. See {@link CredentialRejectedBy}. */
  readonly source: CredentialRejectedBy;

  constructor(
    message: string,
    options?: {
      status?: number;
      source?: CredentialRejectedBy;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options?.cause });
    this.status = options?.status;
    this.source = options?.source ?? "unknown";
  }

  /**
   * Structural check rather than `instanceof`.
   *
   * A Worker bundle can end up with two copies of this module (core linked as a
   * tarball while a plugin resolves its own), and `instanceof` fails across
   * them — the same realm hazard `AGENTS.md` calls out for `agents`. The name is
   * a readonly literal, so this is as strong in practice and survives bundling.
   *
   * It is also what lets a provider outside core raise one: anything named
   * `CredentialRejectedError` with a `source` is honoured, no shared class
   * identity required.
   */
  static isInstance(err: unknown): err is CredentialRejectedError {
    return err instanceof Error && err.name === "CredentialRejectedError";
  }
}
