/**
 * This deployment's own public origin — learned from the request path, never
 * configured.
 *
 * ## Why an agent needs it at all
 *
 * A Worker that only *answers* never needs to know its own name.
 * {@link file://../worker/index.ts createA2AWorker} derives its audience, its
 * card and its `jku` from `new URL(request.url).origin`, and none of it outlives
 * the request. An agent that **calls out** mint-signed does need it:
 * {@link file://./caller-token.ts signCallerToken} puts it in `iss` and derives
 * the token's `jku` from it. That call happens inside a Durable Object, where
 * there is no `Request` — which is the whole difficulty.
 *
 * The obvious answer is a `SELF_ORIGIN` secret, and it is the wrong one. It
 * restates a value the request already carries, and it has to be kept
 * byte-identical by hand with the origin allowlist on the far side, in every
 * environment, forever. Both siblings that tried it took it back out:
 * `looping-anthropic-proxy` deleted `PROXY_AUDIENCE` in favour of `url.origin`,
 * and `looping-gateway` discovers its own origin from the first
 * signature-verified request rather than being told.
 *
 * ## Where the value comes from
 *
 * Core already sends the origin into the Durable Object on every turn, one field
 * short of this use. `A2AExecutor` computes `jku` as `${origin}${jwksPath}` and
 * it rides {@link file://./push.ts TurnPushContext} through the Workflow into
 * `runTaskTurn` and `executeSubtaskChunk`.
 *
 * That is the same origin `signCallerToken` needs, and not by coincidence: a
 * caller token's `jku` **must** be the JWKS the verifier fetches, and `iss` must
 * agree with it — the third check in {@link file://./verify.ts verify.ts}. An
 * origin derived from anywhere else is exactly what that check exists to catch,
 * so deriving it from the `jku` core already serves makes the agreement
 * structural instead of clerical.
 *
 * ## In memory, deliberately
 *
 * Nothing here is persisted, and that is the same call the proxy made. A Worker
 * answers on its custom domain, its `workers.dev` name and every per-version
 * preview URL, so an origin pinned from the first request an isolate happened to
 * see is wrong for every request that arrives on one of the others — and a
 * domain change would outlive the deployment that made it.
 *
 * Relearning costs nothing: every path that can mint a token is downstream of a
 * call that carries the origin, so an evicted isolate is repopulated before its
 * next model call. It is the same trade as `identityKey` in
 * {@link file://../host/agent.ts LoopingAgent}, for the same reason.
 */
export class SelfOrigin {
  private observed?: string;

  /** The raw string {@link observed} was parsed from — see {@link note}. */
  private lastNoted?: string;

  /**
   * Record the origin of an absolute URL seen on the request path — a `jku`, an
   * endpoint, or a bare origin. Only `.origin` is kept, so a path or a trailing
   * slash cannot reach a token claim.
   *
   * Silently ignores anything unusable (absent, relative, or a scheme that has
   * no meaningful origin). This runs at the top of a turn, where a diagnostic
   * value must never be the thing that fails it; the throw belongs at
   * {@link require}, where something actually wanted the value.
   *
   * Called several times per round with the same `jku` — at each RPC entry and
   * again when the push channel is built — so an identical string skips the
   * parse. A string compare, not a pin: a *different* origin still replaces the
   * one held, which is the whole point of not caching this.
   */
  note(url: string | undefined): void {
    if (!url || url === this.lastNoted) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    this.lastNoted = url;
    this.observed = parsed.origin;
  }

  /** The origin observed so far, or `undefined` when nothing has carried one. */
  peek(): string | undefined {
    return this.observed;
  }

  /**
   * The observed origin, for a caller that cannot proceed without it.
   *
   * Throws naming the timing, because that is what the mistake always is: the
   * value arrives with a turn, so `onStart`, a constructor and a scheduled
   * callback all run before any request has said what this deployment is called.
   */
  require(): string {
    if (!this.observed) {
      throw new Error(
        "this deployment's own origin is not known on this instance yet: it is " +
          "learned from the `jku` that arrives with every turn, so it is " +
          "available inside a turn or a subtask chunk — not from onStart, a " +
          "constructor or a scheduled callback"
      );
    }
    return this.observed;
  }
}
