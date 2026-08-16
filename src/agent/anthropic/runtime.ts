import Anthropic from "@anthropic-ai/sdk";
import type { LanguageModel } from "ai";
import type { ModelConfig } from "../../config.js";
import type { CredentialRejectedBy } from "../errors.js";
import type {
  GatewayMetadata,
  ModelOverrides,
  ModelPair,
  ModelRuntime
} from "../model.js";
import { createAnthropicLanguageModel } from "./language-model.js";
import type { CacheTtl } from "./prompt.js";

/**
 * A {@link ModelRuntime} backed by Claude, for agents whose work justifies it.
 *
 * `ModelRuntime` / `ModelPair` were already the right interface — the Workers AI
 * implementation in {@link file://../model.ts model.ts} is one implementation of
 * it, not the definition. This is a sibling, so an agent switches providers by
 * overriding `modelRuntime()` and changes nothing else.
 *
 * Provider choice is per **agent**, not per deployment: the fleet keeps running
 * on Workers AI and one tenant opts into Claude.
 */

export interface AnthropicRuntimeDeps {
  /**
   * Base URL for the Messages API.
   *
   * A thunk because the useful value — `env.AI.gateway(id).getUrl("anthropic")`
   * — is only obtainable once bindings exist. Routing through AI Gateway is what
   * keeps Claude calls in the same logs as every Workers AI call; point it at
   * `https://api.anthropic.com` to bypass the gateway.
   */
  baseUrl: () => string | Promise<string>;
  /**
   * The bearer credential, resolved lazily so a rotated secret is picked up by
   * the next isolate without a redeploy.
   *
   * Async-capable, like {@link baseUrl}, because the credential is not always a
   * stored secret. A deployment that puts an authenticated intermediary in
   * front of Anthropic mints a short-lived token per request instead — signing
   * is asynchronous, and a token with a lifetime measured in minutes cannot be
   * captured once and reused, which is why the client is rebuilt per call
   * rather than memoized. See the note above `clientFor`.
   */
  authToken: () => string | Promise<string>;
  /**
   * AI Gateway token, when the gateway has **Authenticated Gateway** enabled.
   *
   * Required in that case and only that case, which is why it is optional:
   * pointing `baseUrl` at `api.anthropic.com`, or at a gateway with
   * authentication off, must keep working with no token at all.
   *
   * Easy to miss, because the agents on Workers AI never need it — `env.AI.run()`
   * reaches the gateway through the binding, which the platform authenticates.
   * Only a client calling the **provider-native URL** presents credentials of
   * its own, and a gateway with authentication on rejects it at the door: a
   * `401` that never reaches Anthropic and never appears in the gateway's own
   * call log, which makes it look like the model credential was refused.
   */
  gatewayToken?: () => string | undefined;
  /** Model ids, gateway slug and output ceiling — the agent's resolved config. */
  config: ModelConfig;
  /**
   * `output_config.effort`. Coding and agentic work wants `"xhigh"`; the API
   * default is `"high"`. Core does not choose this — the agent does.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Prompt-cache TTL. `"1h"` costs 2x on write instead of 1.25x and is the right
   * call for an agent whose rounds are separated by minutes of tool work — a
   * container boot, an install, a test suite — because a 5-minute entry has
   * expired by the next round and the whole prefix is re-billed at full price.
   */
  cache?: CacheTtl | false;
  /**
   * Recognise a deployment-specific authority in a rejected-credential body —
   * notably the intermediary {@link gatewayToken}'s note describes, which fails
   * with the same `401` as the gateway and the provider and has a completely
   * different remedy. See
   * {@link file://./language-model.ts AnthropicModelDeps.classifyAuthFailure}.
   */
  classifyAuthFailure?: (body: unknown) => CredentialRejectedBy | undefined;
  /** Escape hatch for tests: use this instead of constructing a real client. */
  clientOverride?: Anthropic;
}

/**
 * The beta Anthropic requires to accept a bearer credential rather than an
 * `x-api-key`.
 */
const OAUTH_BETA = "oauth-2025-04-20";

/**
 * AI Gateway's per-request log metadata header.
 *
 * Core already stamps `{taskId, round}` on a turn and `{taskId, subtaskId}` on a
 * subagent chunk so a model call can be tied back to the work that made it; the
 * Workers AI provider carries that in its settings object. Anthropic has no such
 * field, so it rides as a header instead — same correlation, different envelope.
 * Capped at five entries by the gateway; extra keys are dropped there, so trim
 * here rather than sending something that silently truncates.
 */
const GATEWAY_METADATA_HEADER = "cf-aig-metadata";
const GATEWAY_METADATA_MAX_ENTRIES = 5;

/**
 * AI Gateway's own authorization header — deliberately *not* `Authorization`,
 * which already carries the model provider's credential on the same request.
 * Two independent authorities, two headers.
 *
 * A client header rather than a per-pair one: it authenticates the caller to the
 * gateway, which does not vary by task or round, unlike
 * {@link GATEWAY_METADATA_HEADER}.
 */
const GATEWAY_AUTH_HEADER = "cf-aig-authorization";

function metadataHeaders(
  metadata: GatewayMetadata | undefined
): Record<string, string> {
  if (!metadata) return {};
  const entries = Object.entries(metadata).slice(
    0,
    GATEWAY_METADATA_MAX_ENTRIES
  );
  if (entries.length === 0) return {};
  return {
    [GATEWAY_METADATA_HEADER]: JSON.stringify(Object.fromEntries(entries))
  };
}

export function createAnthropicModelRuntime(
  deps: AnthropicRuntimeDeps
): ModelRuntime {
  const { config } = deps;

  /**
   * The resolved base URL, memoized — **not** the client.
   *
   * Resolving is what is expensive and what must not happen at module scope:
   * `wrangler deploy` evaluates module scope to validate the new version and
   * bindings are unpopulated at that point, so an eager `baseUrl()` would throw
   * during deploy. That argument is about the *URL*, which is why it is the URL
   * that is cached.
   *
   * Assigned only on success, so a failed gateway lookup is retried on the next
   * round rather than cached as a rejected promise for the life of the isolate.
   * Two concurrent first calls may each resolve one; they are identical, and
   * the cost is a spare string.
   */
  let resolvedBaseUrl: string | undefined;

  /**
   * A client per call, deliberately.
   *
   * This used to memoize the `Anthropic` instance, which bakes the credential
   * in at construction. That is correct only while the credential outlives the
   * isolate. It does not when {@link AnthropicRuntimeDeps.authToken} mints a
   * short-lived token per request: the first call succeeds, and every call
   * after the token's lifetime gets a `401` — intermittently, only under
   * sustained load, and pointing at the wrong secret.
   *
   * Rebuilding is close to free. `new Anthropic({...})` is pure config
   * assembly — no network, no handshake — so the per-call cost is an object
   * allocation, against a correctness bug that only appears in production.
   * The per-pair headers ride on the request rather than the client, so nothing
   * else depended on the instance being shared.
   */
  const clientFor = async (): Promise<Anthropic> => {
    if (deps.clientOverride) return deps.clientOverride;
    // Awaited, not cast. `env.AI.gateway(id).getUrl()` returns a PROMISE:
    // handing it to `baseURL` unresolved type-checks only behind an `as
    // string`, then fails deep inside the SDK on `baseURL.endsWith is not a
    // function`, on every request, with nothing naming the gateway. The await
    // is why this thunk is async and why `client` is awaited at the call site.
    resolvedBaseUrl ??= await deps.baseUrl();
    const gatewayToken = deps.gatewayToken?.();
    return new Anthropic({
      authToken: await deps.authToken(),
      // Explicitly null, or the SDK falls back to resolving credentials from
      // config files and env vars — which on Workers means a confusing failure
      // far from the actual misconfiguration.
      apiKey: null,
      baseURL: resolvedBaseUrl,
      defaultHeaders: {
        "anthropic-beta": OAUTH_BETA,
        ...(gatewayToken
          ? { [GATEWAY_AUTH_HEADER]: `Bearer ${gatewayToken}` }
          : {})
      },
      // Retry lives one layer up, in the AI SDK, which is the only layer that
      // honours the provider's own `retry-after` — see `ModelConfig.maxRetries`
      // and the `APICallError` mapping that feeds it. A second layer here would
      // multiply that wait and defeat the fallback's timing.
      maxRetries: 0
    });
  };

  return {
    createModelPair(overrides: ModelOverrides = {}): ModelPair {
      const primaryId = overrides.primaryModelId ?? config.chatModelId;
      const fallbackId =
        overrides.fallbackModelId ?? config.fallbackChatModelId;
      const headers = metadataHeaders(overrides.metadata);

      const build = (modelId: string): LanguageModel =>
        createAnthropicLanguageModel({
          client: clientFor,
          modelId,
          defaultMaxTokens: config.maxOutputTokens,
          ...(deps.effort ? { effort: deps.effort } : {}),
          ...(deps.cache !== undefined ? { cache: deps.cache } : {}),
          ...(deps.classifyAuthFailure
            ? { classifyAuthFailure: deps.classifyAuthFailure }
            : {}),
          headers
        });

      let primary: LanguageModel | undefined;
      let fallback: LanguageModel | undefined;
      return {
        primary: () => (primary ??= overrides.model ?? build(primaryId)),
        fallback: () =>
          (fallback ??=
            overrides.fallbackModel ?? overrides.model ?? build(fallbackId)),
        primaryId: () => primaryId,
        fallbackId: () => fallbackId
      };
    }
  };
}
