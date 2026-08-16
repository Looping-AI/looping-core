import type Anthropic from "@anthropic-ai/sdk";
// The class from `ai`, the types from `@ai-sdk/provider`. `ai` re-exports
// `APICallError` and is a required peer, so the only thing this adapter needs the
// provider package for is types — which erase at build, and which `ai` does not
// re-export.
import { APICallError, UnsupportedFunctionalityError } from "ai";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Usage,
  SharedV4Warning
} from "@ai-sdk/provider";
import {
  CredentialRejectedError,
  type CredentialRejectedBy
} from "../errors.js";
import {
  ANTHROPIC_PROVIDER,
  collectSamplingWarnings,
  mapPrompt,
  mapToolChoice,
  mapTools,
  type CacheTtl
} from "./prompt.js";

/**
 * A `LanguageModelV4` over `@anthropic-ai/sdk`, so core's loops can call Claude
 * without knowing they are.
 *
 * Every loop in core is written against `generateText` from `ai` and a
 * `LanguageModel` — {@link file://../../round/turn.ts turn.ts},
 * {@link file://../../subagent/run.ts run.ts} and
 * {@link file://../session.ts session.ts}. Satisfying that interface is what
 * keeps the round loop, the control-tool repair ladder, subtask execution and
 * the Workflow untouched by a second provider. The alternative — a bespoke
 * Messages-API loop for one agent — would have given all of that up.
 *
 * `ai@7` accepts `LanguageModelV2 | V3 | V4`; this targets **v4**, the newest
 * the installed `@ai-sdk/provider` defines.
 */

/** How the adapter reaches the API. Everything is injected so nothing reads env. */
export interface AnthropicModelDeps {
  /**
   * Constructed lazily by the runtime — see the note in
   * {@link file://./runtime.ts}. Awaited, because building it has to resolve
   * `env.AI.gateway(id).getUrl()`, which is async.
   */
  client: () => Anthropic | Promise<Anthropic>;
  /** Anthropic model id, e.g. `claude-opus-5`. */
  modelId: string;
  /** `max_tokens` when a caller supplies none. Anthropic requires the field. */
  defaultMaxTokens: number;
  /** Prompt-cache TTL, or `false` to place no breakpoints. Defaults to `"5m"`. */
  cache?: CacheTtl | false;
  /**
   * Reasoning effort, when the caller does not set one per-call.
   *
   * Maps to `output_config.effort`. Coding and agentic work wants `"xhigh"`;
   * `"high"` is the API default. Core never picks this — an agent does.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Extra headers merged into every request (AI Gateway metadata lives here). */
  headers?: Record<string, string>;
  /**
   * Recognise a deployment-specific authority in a `401`/`403` body.
   *
   * Consulted before the built-in shapes; return `undefined` to fall through to
   * them. It exists because a deployment may put an authenticated intermediary
   * between the gateway and Anthropic, and only that deployment knows what its
   * refusal looks like — core recognising one particular proxy's error body
   * would be exactly the deployment policy this package does not ship.
   *
   * The remedy is what makes it worth distinguishing at all: a proxy that mints
   * its caller credential per request has no secret to rotate, so reporting its
   * `401` as `credential` sends an operator to replace a working token. See
   * {@link file://../errors.ts CredentialRejectedBy}.
   */
  classifyAuthFailure?: (body: unknown) => CredentialRejectedBy | undefined;
}

/**
 * Anthropic `stop_reason` → the spec's unified finish reason.
 *
 * `raw` is always carried through: the unified set is lossy, and a caller
 * debugging a truncated round wants to know it was `max_tokens` specifically.
 */
function mapFinishReason(
  stopReason: Anthropic.StopReason | null
): LanguageModelV4FinishReason {
  const raw = stopReason ?? undefined;
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return { unified: "stop", raw };
    case "max_tokens":
      return { unified: "length", raw };
    case "tool_use":
      return { unified: "tool-calls", raw };
    case "refusal":
      return { unified: "content-filter", raw };
    case "pause_turn":
      return { unified: "other", raw };
    default:
      return { unified: "other", raw };
  }
}

/** Anthropic usage → the spec's nested counters. */
function mapUsage(usage: Anthropic.Usage | undefined): LanguageModelV4Usage {
  const cacheWrite = usage?.cache_creation_input_tokens ?? undefined;
  const cacheRead = usage?.cache_read_input_tokens ?? undefined;
  const noCache = usage?.input_tokens ?? undefined;
  // `input_tokens` is the *uncached remainder*, so the true prompt size is the
  // sum. Reporting only `input_tokens` as the total is the classic misread that
  // makes a well-cached agent look like it is barely sending any context.
  const total =
    noCache === undefined && cacheRead === undefined && cacheWrite === undefined
      ? undefined
      : (noCache ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);

  return {
    inputTokens: { total, noCache, cacheRead, cacheWrite },
    outputTokens: {
      total: usage?.output_tokens ?? undefined,
      text: undefined,
      reasoning: undefined
    }
  };
}

/**
 * Anthropic content blocks → spec content parts.
 *
 * Two details that corrupt silently if missed:
 *
 * - `tool-call.input` is a **JSON string** on the result side, even though the
 *   same-named field on the prompt side is a parsed value.
 * - a `thinking` block's `signature` must survive into `providerMetadata`, or
 *   the next turn cannot replay it and the round after this one fails.
 */
function mapContent(
  blocks: Anthropic.ContentBlock[]
): LanguageModelV4Content[] {
  const content: LanguageModelV4Content[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;

      case "thinking":
        content.push({
          type: "reasoning",
          text: block.thinking,
          providerMetadata: {
            [ANTHROPIC_PROVIDER]: { signature: block.signature }
          }
        });
        break;

      case "redacted_thinking":
        content.push({
          type: "reasoning",
          text: "",
          providerMetadata: {
            [ANTHROPIC_PROVIDER]: { redactedData: block.data }
          }
        });
        break;

      case "tool_use":
        content.push({
          type: "tool-call",
          toolCallId: block.id,
          toolName: block.name,
          // Result side: a JSON string, not the object.
          input: JSON.stringify(block.input ?? {})
        });
        break;

      default:
        // Server-tool blocks (web search, code execution, …). Core never asks
        // for them; ignoring is correct and quiet is fine — a warning per block
        // would be noise on a feature nobody enabled.
        break;
    }
  }
  return content;
}

/**
 * Which authority refused, read off the response body the SDK parsed onto
 * `APIError.error`.
 *
 * Only the two authorities *core itself* puts on the path are recognised here.
 * They are unmistakable once you have seen them, and nothing else distinguishes
 * them — same status, same header set:
 *
 * ```jsonc
 * // AI Gateway, authentication enabled and no cf-aig-authorization sent
 * { "name": "AiGatewayError", "internalCode": 2009, "message": "Unauthorized" }
 * // Anthropic
 * { "type": "error", "error": { "type": "authentication_error", … } }
 * ```
 *
 * Matched on `name` **or** `internalCode`, because either alone is a single
 * upstream rename away from silently falling through to `"unknown"`.
 *
 * A deployment that puts its own intermediary between the two supplies
 * {@link AnthropicModelDeps.classifyAuthFailure}, which is consulted first —
 * that body's shape is the deployment's fact, not core's.
 */
function rejectedBy(
  body: unknown,
  classify: AnthropicModelDeps["classifyAuthFailure"]
): CredentialRejectedBy {
  const declared = classify?.(body);
  if (declared) return declared;
  if (typeof body !== "object" || body === null) return "unknown";
  const parsed = body as {
    name?: unknown;
    internalCode?: unknown;
    error?: { type?: unknown } | null;
  };
  if (parsed.name === "AiGatewayError" || parsed.internalCode === 2009)
    return "gateway";
  if (parsed.error?.type === "authentication_error") return "provider";
  return "unknown";
}

/**
 * Anthropic's `Headers` (or whatever the SDK put there) as the plain object the
 * AI SDK's retry logic indexes.
 *
 * `getRetryDelayInMs` reads `headers["retry-after-ms"]` and `headers["retry-after"]`
 * with bracket access — a `Headers` instance answers `undefined` to both, so the
 * wait silently degrades to plain exponential backoff and the provider's own
 * "come back in N seconds" is thrown away. Lowercased on the way in because HTTP
 * header names are case-insensitive and `Headers.forEach` is the only iteration
 * order we can rely on.
 */
function plainHeaders(value: unknown): Record<string, string> | undefined {
  if (!value) return undefined;
  const out: Record<string, string> = {};
  if (typeof (value as Headers).forEach === "function") {
    (value as Headers).forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (typeof value !== "object") return undefined;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * A provider error in the shape the AI SDK's retry logic can act on.
 *
 * This is what makes `maxRetries` mean anything for this adapter. `ai`'s
 * `retryWithExponentialBackoffRespectingRetryHeaders` gates on
 * `APICallError.isInstance(error) && error.isRetryable`, so a raw
 * `@anthropic-ai/sdk` error — which is what this used to rethrow — is never
 * retried, however retryable it obviously is. A 429 went straight past the
 * retry, burned the fallback slot on a model sharing the same credential, threw,
 * and made the Workflow retry the entire round instead of waiting the two
 * seconds the provider asked for.
 *
 * `isRetryable` is deliberately not passed: `APICallError` derives it from the
 * status (408/409/429/5xx), which is exactly the policy we want and one fewer
 * place for the two to disagree.
 *
 * Credentials are handled *before* this — see the call site. A 401 must stay
 * non-retryable and non-fallback-able, and it reaches core as
 * {@link CredentialRejectedError} instead.
 */
function asApiCallError(
  err: unknown,
  body: Anthropic.MessageStreamParams
): APICallError | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== "number") return undefined;
  const source = err as {
    message?: string;
    headers?: unknown;
    error?: unknown;
    request_id?: string;
  };
  return new APICallError({
    message: source.message ?? `Anthropic request failed with ${status}`,
    // The gateway's provider-native URL is resolved per call inside the client,
    // so the adapter does not hold it. The model id is the useful half anyway.
    url: `anthropic:messages:${body.model}`,
    requestBodyValues: body as unknown as Record<string, unknown>,
    statusCode: status,
    responseHeaders: plainHeaders(source.headers),
    responseBody:
      source.error === undefined ? undefined : JSON.stringify(source.error),
    cause: err
  });
}

/**
 * Recognise a rejected credential, and say whose.
 *
 * Structural rather than `instanceof Anthropic.AuthenticationError`: the SDK is
 * an optional peer, so a bundle can hold two copies, and this must not depend on
 * which one threw.
 */
function asCredentialError(
  err: unknown,
  classify: AnthropicModelDeps["classifyAuthFailure"]
): CredentialRejectedError | undefined {
  if (CredentialRejectedError.isInstance(err)) return err;
  const status = (err as { status?: unknown } | null)?.status;
  if (status !== 401 && status !== 403) return undefined;
  const message =
    err instanceof Error ? err.message : "a credential was rejected";
  return new CredentialRejectedError(message, {
    status: status as number,
    source: rejectedBy((err as { error?: unknown } | null)?.error, classify),
    cause: err
  });
}

export function createAnthropicLanguageModel(
  deps: AnthropicModelDeps
): LanguageModelV4 {
  const cache = deps.cache ?? "5m";
  const ttl = cache === false ? undefined : cache;

  return {
    specificationVersion: "v4",
    provider: ANTHROPIC_PROVIDER,
    modelId: deps.modelId,
    // Anthropic fetches image and PDF URLs itself, so the SDK need not download
    // and re-encode them.
    supportedUrls: {
      "image/*": [/^https?:\/\/.+$/],
      "application/pdf": [/^https?:\/\/.+$/]
    },

    async doGenerate(
      options: LanguageModelV4CallOptions
    ): Promise<LanguageModelV4GenerateResult> {
      const warnings: SharedV4Warning[] = [...collectSamplingWarnings(options)];

      const {
        system,
        messages,
        warnings: promptWarnings
      } = mapPrompt(options.prompt, {
        cache,
        defaultMaxTokens: deps.defaultMaxTokens
      });
      warnings.push(...promptWarnings);

      const tools = options.tools
        ? mapTools(options.tools, ttl, warnings)
        : undefined;

      if (options.responseFormat?.type === "json") {
        warnings.push({
          type: "unsupported",
          feature: "responseFormat",
          details:
            "structured outputs are not mapped yet; use a tool with a strict schema"
        });
      }

      const effort = mapEffort(options.reasoning ?? deps.effort, warnings);
      const body: Anthropic.MessageStreamParams = {
        model: deps.modelId,
        max_tokens: options.maxOutputTokens ?? deps.defaultMaxTokens,
        messages,
        ...(system ? { system } : {}),
        ...(tools ? { tools } : {}),
        ...(options.toolChoice
          ? { tool_choice: mapToolChoice(options.toolChoice) }
          : {}),
        ...(options.stopSequences?.length
          ? { stop_sequences: options.stopSequences }
          : {}),
        ...(effort ? { output_config: { effort } } : {})
      };

      try {
        // Streamed on the wire, accumulated here into the single result the
        // spec returns. This is not an optimisation and not optional: the SDK
        // refuses a NON-streaming request outright — before any network call —
        // once `max_tokens` implies a response that could take more than ten
        // minutes, at `(60 * 60 * max_tokens) / 128_000 > 600`, i.e. above
        // 21,333 tokens. An agent whose whole point is long output would have
        // to be capped below that ceiling to use `create`.
        //
        // `doStream` still throws: what streams is the transport, not this
        // adapter's contract. Core calls `generateText`, which wants one
        // result, and it gets one.
        const client = await deps.client();
        const response = await client.messages
          .stream(body, {
            ...(options.abortSignal ? { signal: options.abortSignal } : {}),
            headers: { ...deps.headers, ...stripUndefined(options.headers) }
          })
          .finalMessage();

        return {
          // `refusal` arrives as a normal 200 with empty or partial content, so
          // this must never assume `content[0]` exists.
          content: mapContent(response.content ?? []),
          finishReason: mapFinishReason(response.stop_reason),
          usage: mapUsage(response.usage),
          warnings,
          request: { body },
          response: { id: response.id, modelId: response.model }
        };
      } catch (err) {
        // Credentials first, and the order is the whole point: a 401 is a
        // status the generic mapper below would happily wrap, and an
        // `APICallError` is something core's ladder is allowed to fall back
        // from. A dead token must stop the task instead.
        const credential = asCredentialError(err, deps.classifyAuthFailure);
        if (credential) throw credential;
        // Everything else in the shape the SDK's retry and core's transient
        // classifier can both read. See {@link asApiCallError}.
        const apiError = asApiCallError(err, body);
        if (apiError) throw apiError;
        throw err;
      }
    },

    /**
     * Not implemented, deliberately. Core's loops call `generateText`, which
     * never touches `doStream` — what streams is the transport inside
     * `doGenerate`, not this adapter's contract. The spec's own error is the
     * right one: it fails by name, and a caller reaching for `streamText` sees
     * which method is missing rather than something half-formed.
     */
    doStream(): never {
      throw new UnsupportedFunctionalityError({
        functionality: "doStream",
        message:
          "The Anthropic adapter implements doGenerate only. " +
          "Core's loops call generateText, which never streams. " +
          "Implement doStream in @loopingai/core/anthropic before using streamText."
      });
    }
  };
}

/**
 * Reasoning effort → `output_config.effort`, or nothing.
 *
 * The two vocabularies overlap but are not the same, and the difference is a
 * 400 rather than a type error: the spec's `reasoning` includes `"minimal"`,
 * which Anthropic's `effort` does not define. Casting across them — which is
 * what this replaced — silences the one check that would have caught it.
 *
 * `provider-default` and `none` mean "say nothing", so the field is omitted and
 * the API picks. `minimal` is mapped down to the nearest real level rather than
 * dropped: the caller asked for *less* thinking, and omitting the field would
 * silently give them the API default of `high` — the opposite.
 */
function mapEffort(
  reasoning: string | undefined,
  warnings: SharedV4Warning[]
): Anthropic.OutputConfig["effort"] | undefined {
  switch (reasoning) {
    case undefined:
    case "provider-default":
    case "none":
      return undefined;
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return reasoning;
    case "minimal":
      warnings.push({
        type: "unsupported",
        feature: "reasoning",
        details: 'Anthropic has no "minimal" effort; sent "low" instead'
      });
      return "low";
    default:
      warnings.push({
        type: "unsupported",
        feature: "reasoning",
        details: `unknown reasoning effort "${reasoning}"; the field was omitted`
      });
      return undefined;
  }
}

/** The spec allows `undefined` header values; `fetch` does not. */
function stripUndefined(
  headers: Record<string, string | undefined> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
