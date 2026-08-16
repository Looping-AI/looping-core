import type Anthropic from "@anthropic-ai/sdk";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4ProviderTool,
  LanguageModelV4ToolChoice,
  LanguageModelV4ToolResultOutput,
  SharedV4FileData,
  SharedV4Warning
} from "@ai-sdk/provider";

/**
 * The AI SDK prompt → Anthropic Messages request mapping.
 *
 * Split out from the model itself because it is pure: prompt in, request body
 * plus warnings out, no client and no I/O. That is what makes the sharp edges
 * below testable without a network or a cassette, and every one of them is a
 * silent-corruption bug rather than a loud one.
 *
 * Three shape mismatches do the real damage if you get them wrong:
 *
 * 1. **There is no `tool` role in the Messages API.** The AI SDK models tool
 *    results as their own role; Anthropic carries them as `tool_result` blocks
 *    inside a **user** turn.
 * 2. **`thinking` blocks are signed and must be replayed byte-for-byte.** Opus 5
 *    runs adaptive thinking by default and rejects a modified block. Core's loop
 *    is multi-turn tool use on every round, so it replays the previous assistant
 *    message every single time — drop or rebuild the signature and round two of
 *    every task 400s.
 * 3. **`input` is a parsed value on the way in and a JSON string on the way
 *    out.** `LanguageModelV4ToolCallPart.input` (prompt side) is `unknown`;
 *    `LanguageModelV4ToolCall.input` (result side) is `string`. Mixing them up
 *    type-checks and corrupts silently.
 */

/** Namespaced provider key for anything we stash on a part. */
export const ANTHROPIC_PROVIDER = "anthropic";

/** Anything Anthropic will not accept in a `tool_use.id`. */
const UNSAFE_TOOL_CALL_ID = /[^a-zA-Z0-9_-]/g;

/**
 * A tool-call id Anthropic will accept, from one it might not.
 *
 * The API validates this field against `^[a-zA-Z0-9_-]+$` and answers a
 * violation with a `400 invalid_request_error` naming the exact message index —
 * `messages.7.content.1.tool_use.id`. That is a *deterministic* failure on
 * replayed history, which makes it the worst kind: every retry and every
 * fallback re-sends the same poisoned message list and fails identically, so the
 * round burns its whole ladder without a single attempt that could have worked.
 * It cost a production task exactly that way.
 *
 * Applied to both sides of the pair — the assistant's `tool_use.id` and the
 * user turn's `tool_result.tool_use_id` — because the two must agree or the
 * request is malformed in a second, more confusing way. Since the mapping is a
 * pure function of the id, applying it independently at both call sites lands on
 * the same answer without threading state between them.
 *
 * This is a **backstop**, not the fix. Core's own generators emit safe ids
 * directly (see {@link file://../../subtasks/delegate.ts delegateToolCallId});
 * this catches the next generator someone writes, and any id that reaches the
 * adapter from outside core.
 *
 * Not injective, and deliberately not made so: two ids differing only in
 * unsafe characters collapse together. Adding a hash to avoid that would change
 * every id to guard against a collision that requires two synthetic calls in one
 * request whose ids differ *only* in punctuation. Provider-legible ids are worth
 * more than that.
 */
export function providerSafeToolCallId(id: string): string {
  return id.replace(UNSAFE_TOOL_CALL_ID, "_");
}

/**
 * How long a cache entry should live.
 *
 * `"5m"` is Anthropic's default and suits back-to-back model calls. `"1h"`
 * costs 2x on write instead of 1.25x and exists for agents whose rounds are
 * separated by long tool work — a container boot, an install, a test suite —
 * where a 5-minute entry has expired by the time the next round starts and the
 * whole prefix is re-billed at full price.
 */
export type CacheTtl = "5m" | "1h";

export interface PromptMappingOptions {
  /** Cache TTL, or `false` to place no breakpoints at all. */
  cache?: CacheTtl | false;
  /** `max_tokens` when the caller supplied none. Anthropic requires the field. */
  defaultMaxTokens: number;
}

export interface MappedPrompt {
  system: Anthropic.TextBlockParam[] | undefined;
  messages: Anthropic.MessageParam[];
  warnings: SharedV4Warning[];
}

/**
 * Anthropic's cache marker.
 *
 * `{type:"ephemeral"}` is the *cache-on* switch and the only `cache_control`
 * type there is — "ephemeral" describes the entry's lifetime, not its value.
 * Omitting the field is what disables caching.
 */
function cacheControl(ttl: CacheTtl): Anthropic.CacheControlEphemeral {
  return ttl === "1h"
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };
}

/**
 * At most four `cache_control` breakpoints are allowed per request, and they are
 * spent stability-first because the cache is a **prefix** match and the render
 * order is `tools` → `system` → `messages`:
 *
 * - one on the last tool (frozen for the agent's lifetime)
 * - one on the last system block (frozen)
 * - up to two rolling ones in the conversation
 *
 * The second rolling breakpoint is not redundant. Each breakpoint walks back at
 * most **20 content blocks** looking for a live entry, and one busy round of an
 * agent that calls tools in a loop adds a `tool_use`/`tool_result` pair per
 * call — well past 20 in a single turn. Without an anchor partway back, the next
 * request finds nothing, silently misses, and re-bills the entire prefix with no
 * error to notice.
 */
const MESSAGE_BREAKPOINT_STRIDE = 15;

/** Which content blocks a `file` part can become, by media type. */
function fileBlock(
  data: SharedV4FileData,
  mediaType: string,
  warnings: SharedV4Warning[]
): Anthropic.ContentBlockParam | undefined {
  const unsupported = (details: string): undefined => {
    warnings.push({ type: "unsupported", feature: "file-part", details });
    return undefined;
  };

  if (data.type === "reference")
    return unsupported("provider file references are not supported");
  if (data.type === "text")
    return { type: "text", text: data.text } satisfies Anthropic.TextBlockParam;

  const isImage = mediaType.startsWith("image/");
  const isPdf = mediaType === "application/pdf";
  if (!isImage && !isPdf)
    return unsupported(`unsupported media type "${mediaType}"`);

  if (data.type === "url") {
    const url = data.url.toString();
    return isImage
      ? { type: "image", source: { type: "url", url } }
      : { type: "document", source: { type: "url", url } };
  }

  // `data` is raw bytes or an already-base64 string. Anthropic wants base64.
  const base64 =
    typeof data.data === "string" ? data.data : bytesToBase64(data.data);
  return isImage
    ? {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType as Anthropic.Base64ImageSource["media_type"],
          data: base64
        }
      }
    : {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 }
      };
}

/**
 * Base64 without `Buffer`.
 *
 * Core targets workerd, where `Buffer` only exists under `nodejs_compat` and
 * core must not assume a consumer enabled it. Chunked so a large file cannot
 * blow the argument limit of `String.fromCharCode`.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Read a signature previously stashed on a reasoning part.
 *
 * Written by the response mapper into `providerMetadata.anthropic.signature`;
 * the SDK hands it back as `providerOptions.anthropic.signature`. Both halves
 * have to agree exactly — this is the single most load-bearing line in the file.
 */
function signatureOf(
  providerOptions: Record<string, unknown> | undefined
): string | undefined {
  const own = providerOptions?.[ANTHROPIC_PROVIDER] as
    Record<string, unknown> | undefined;
  const signature = own?.["signature"];
  return typeof signature === "string" ? signature : undefined;
}

/** `redacted_thinking` round-trips as opaque data, same contract as a signature. */
function redactedDataOf(
  providerOptions: Record<string, unknown> | undefined
): string | undefined {
  const own = providerOptions?.[ANTHROPIC_PROVIDER] as
    Record<string, unknown> | undefined;
  const data = own?.["redactedData"];
  return typeof data === "string" ? data : undefined;
}

/** One AI SDK message → zero or more Anthropic messages (before merging). */
function mapMessage(
  message: LanguageModelV4Message,
  warnings: SharedV4Warning[]
): Anthropic.MessageParam | undefined {
  switch (message.role) {
    case "system":
      // Handled by the caller — system text is a top-level field, not a turn.
      return undefined;

    case "user": {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          if (part.text.length > 0)
            content.push({ type: "text", text: part.text });
        } else {
          const block = fileBlock(part.data, part.mediaType, warnings);
          if (block) content.push(block);
        }
      }
      return content.length > 0 ? { role: "user", content } : undefined;
    }

    case "assistant": {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const part of message.content) {
        switch (part.type) {
          case "text":
            // Anthropic rejects an empty text block; the SDK emits them freely.
            if (part.text.length > 0)
              content.push({ type: "text", text: part.text });
            break;

          case "reasoning": {
            const redactedData = redactedDataOf(part.providerOptions);
            if (redactedData !== undefined) {
              content.push({ type: "redacted_thinking", data: redactedData });
              break;
            }
            const signature = signatureOf(part.providerOptions);
            // A thinking block without its signature is rejected outright, and
            // inventing one is worse. Dropping it is the only safe move — but
            // say so, because it means the response mapper lost the metadata.
            if (signature === undefined) {
              warnings.push({
                type: "other",
                message:
                  "dropped a reasoning part with no Anthropic signature; " +
                  "thinking blocks cannot be replayed without one"
              });
              break;
            }
            content.push({ type: "thinking", thinking: part.text, signature });
            break;
          }

          case "tool-call":
            content.push({
              type: "tool_use",
              id: providerSafeToolCallId(part.toolCallId),
              name: part.toolName,
              // Prompt side: already a parsed value. Do NOT stringify.
              input: part.input as Record<string, unknown>
            });
            break;

          case "tool-result":
            // Provider-executed results replayed on the assistant turn. Core
            // never produces these; pass through rather than silently drop.
            warnings.push({
              type: "unsupported",
              feature: "assistant tool-result part",
              details: `tool "${part.toolName}" result on an assistant turn was dropped`
            });
            break;

          case "file": {
            const block = fileBlock(part.data, part.mediaType, warnings);
            if (block) content.push(block);
            break;
          }

          default:
            warnings.push({
              type: "unsupported",
              feature: `assistant part "${(part as { type: string }).type}"`
            });
        }
      }
      return content.length > 0 ? { role: "assistant", content } : undefined;
    }

    case "tool": {
      // The mapping that most often goes wrong: Anthropic has no `tool` role.
      // Tool results ride in a *user* turn as `tool_result` blocks.
      const content: Anthropic.ContentBlockParam[] = [];
      for (const part of message.content) {
        if (part.type !== "tool-result") {
          warnings.push({
            type: "unsupported",
            feature: `tool part "${(part as { type: string }).type}"`
          });
          continue;
        }
        const { text, isError } = toolResultText(part.output);
        content.push({
          type: "tool_result",
          // The same mapping as the `tool_use.id` above, and it has to be: a
          // result whose id no longer matches its call is a malformed request.
          tool_use_id: providerSafeToolCallId(part.toolCallId),
          content: text,
          ...(isError ? { is_error: true } : {})
        });
      }
      return content.length > 0 ? { role: "user", content } : undefined;
    }
  }
}

/** Flatten a V4 tool result into the string Anthropic carries, plus its error flag. */
function toolResultText(output: LanguageModelV4ToolResultOutput): {
  text: string;
  isError: boolean;
} {
  switch (output.type) {
    case "text":
      return { text: output.value, isError: false };
    case "error-text":
      return { text: output.value, isError: true };
    case "json":
      return { text: JSON.stringify(output.value), isError: false };
    case "error-json":
      return { text: JSON.stringify(output.value), isError: true };
    case "execution-denied":
      return {
        text: output.reason ?? "The tool call was denied.",
        isError: true
      };
    case "content":
      return {
        text: output.value
          .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
          .join("\n"),
        isError: false
      };
  }
}

/**
 * Merge consecutive same-role turns.
 *
 * Cheap insurance rather than a hard requirement: the mapping already produces
 * alternating turns for the shapes core generates (an assistant turn of
 * `tool_use` followed by a `tool` message that becomes a user turn). But a
 * caller is free to emit two user messages in a row, and merging is always
 * valid, so the adapter never has to care which API version tightened the rule.
 */
function mergeAdjacent(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  const merged: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      previous.content = hoistToolResults([
        ...(previous.content as Anthropic.ContentBlockParam[]),
        ...(message.content as Anthropic.ContentBlockParam[])
      ]);
      continue;
    }
    merged.push({
      role: message.role,
      content: [...(message.content as Anthropic.ContentBlockParam[])]
    });
  }
  return merged;
}

/**
 * `tool_result` blocks must lead the user turn that answers a `tool_use`.
 *
 * Only reachable via a merge — the mapping alone never mixes them with text —
 * but a caller that puts a user message between an assistant's tool call and its
 * results would otherwise produce `[text, tool_result]`, which the API rejects.
 * Stable within each group, so the pairing with the preceding `tool_use` blocks
 * is preserved.
 */
function hoistToolResults(
  content: Anthropic.ContentBlockParam[]
): Anthropic.ContentBlockParam[] {
  const results = content.filter((block) => block.type === "tool_result");
  if (results.length === 0 || results.length === content.length) return content;
  return [
    ...results,
    ...content.filter((block) => block.type !== "tool_result")
  ];
}

/**
 * Give every `tool_use` a `tool_result`, inventing one where the transcript
 * lost it.
 *
 * Anthropic rejects a request in which an assistant turn calls a tool and the
 * next user turn does not answer it — every id, no exceptions. The mapping above
 * can produce exactly that without anything looking wrong: a `tool` message
 * whose parts were all unmappable maps to `undefined` and is dropped, taking the
 * only `tool_result` for a still-present `tool_use` with it.
 *
 * Synthesising an error result is strictly better than the alternatives. Dropping
 * the `tool_use` too would rewrite what the model actually did, and a `thinking`
 * block signed over that turn would then no longer match. Saying "the result was
 * lost" is true, is what the model would infer anyway, and keeps the turn
 * replayable.
 *
 * **Scope: only a turn with something after it.** A conversation *ending* on an
 * unanswered `tool_use` is a different shape — an assistant prefill — and core
 * never produces one, since `generateText` appends results before the next call.
 * Repairing it would mean appending a turn to a prompt the caller deliberately
 * ended, on a guess about how the API treats it. Left alone until there is a
 * reason to touch it.
 */
function answerOrphanedToolUses(
  messages: Anthropic.MessageParam[],
  warnings: SharedV4Warning[]
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    out.push(message);
    if (message.role !== "assistant") continue;

    const blocks = message.content as Anthropic.ContentBlockParam[];
    const ids = blocks
      .filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use")
      .map((b) => b.id);
    if (ids.length === 0) continue;

    const next = messages[i + 1];
    if (!next) continue;

    const answered = new Set(
      next.role === "user"
        ? (next.content as Anthropic.ContentBlockParam[])
            .filter(
              (b): b is Anthropic.ToolResultBlockParam =>
                b.type === "tool_result"
            )
            .map((b) => b.tool_use_id)
        : []
    );

    const missing = ids.filter((id) => !answered.has(id));
    if (missing.length === 0) continue;

    warnings.push({
      type: "other",
      message:
        `${missing.length} tool call(s) had no result in the prompt; ` +
        "an error result was synthesised so the request stays valid"
    });

    const repairs: Anthropic.ContentBlockParam[] = missing.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: "The result of this tool call was not preserved.",
      is_error: true
    }));

    // Prepended, not appended: `tool_result` blocks must lead their turn, the
    // same rule `hoistToolResults` enforces after a merge.
    if (next.role === "user") {
      next.content = [
        ...repairs,
        ...(next.content as Anthropic.ContentBlockParam[])
      ];
    } else {
      out.push({ role: "user", content: repairs });
    }
  }

  return out;
}

/**
 * Place the rolling conversation breakpoints.
 *
 * Walks the flattened block sequence and marks the last block, plus one
 * `MESSAGE_BREAKPOINT_STRIDE` back when the tail is long enough to outrun the
 * 20-block lookback window. Mutates in place — the messages were already cloned
 * by {@link mergeAdjacent}.
 */
function placeMessageBreakpoints(
  messages: Anthropic.MessageParam[],
  ttl: CacheTtl
): void {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const message of messages) {
    for (const block of message.content as Anthropic.ContentBlockParam[]) {
      blocks.push(block);
    }
  }
  if (blocks.length === 0) return;

  const targets = new Set<number>([blocks.length - 1]);
  if (blocks.length > MESSAGE_BREAKPOINT_STRIDE + 1) {
    targets.add(blocks.length - 1 - MESSAGE_BREAKPOINT_STRIDE);
  }

  for (const index of targets) {
    const block = blocks[index];
    // `thinking` and `redacted_thinking` reject cache_control; skip them rather
    // than 400 the request, and let the neighbouring breakpoint carry the round.
    if (
      !block ||
      block.type === "thinking" ||
      block.type === "redacted_thinking"
    )
      continue;
    (
      block as { cache_control?: Anthropic.CacheControlEphemeral }
    ).cache_control = cacheControl(ttl);
  }
}

/** Map the prompt half of a call: system blocks + turns. */
export function mapPrompt(
  prompt: LanguageModelV4Prompt,
  options: PromptMappingOptions
): MappedPrompt {
  const warnings: SharedV4Warning[] = [];
  const ttl = options.cache === false ? undefined : (options.cache ?? "5m");

  const systemText = prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .filter((text) => text.length > 0);

  const system: Anthropic.TextBlockParam[] | undefined =
    systemText.length > 0
      ? systemText.map((text, index) => ({
          type: "text" as const,
          text,
          // Frozen prefix: one breakpoint on the last block covers tools+system.
          ...(ttl && index === systemText.length - 1
            ? { cache_control: cacheControl(ttl) }
            : {})
        }))
      : undefined;

  const mapped = prompt
    .map((message) => mapMessage(message, warnings))
    .filter(
      (message): message is Anthropic.MessageParam => message !== undefined
    );

  const messages = answerOrphanedToolUses(mergeAdjacent(mapped), warnings);

  // Every mapping branch above drops a turn that maps to nothing, which is
  // right per-message and wrong for the request: Anthropic requires the first
  // turn to be `user`, so a leading user message whose only part was empty text
  // leaves the conversation opening on `assistant` and 400s. Cheaper to notice
  // here than in a log.
  if (messages.length > 0 && messages[0]!.role !== "user") {
    warnings.push({
      type: "other",
      message:
        "the first mapped turn was not a user turn; a placeholder was inserted " +
        "because the Messages API requires the conversation to open on one"
    });
    messages.unshift({ role: "user", content: [{ type: "text", text: "…" }] });
  }

  if (ttl) placeMessageBreakpoints(messages, ttl);

  return { system, messages, warnings };
}

/** Map tool definitions, putting the frozen-prefix breakpoint on the last one. */
export function mapTools(
  tools: Array<LanguageModelV4FunctionTool | LanguageModelV4ProviderTool>,
  ttl: CacheTtl | undefined,
  warnings: SharedV4Warning[]
): Anthropic.ToolUnion[] | undefined {
  const functionTools = tools.filter(
    (tool): tool is LanguageModelV4FunctionTool => tool.type === "function"
  );
  for (const tool of tools) {
    if (tool.type !== "function") {
      warnings.push({
        type: "unsupported",
        feature: "provider-defined tool",
        details: `tool "${tool.name}" was dropped; only function tools are mapped`
      });
    }
  }
  if (functionTools.length === 0) return undefined;

  return functionTools.map((tool, index) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
    ...(ttl && index === functionTools.length - 1
      ? { cache_control: cacheControl(ttl) }
      : {})
  }));
}

/** Map tool choice. Note V4 uses `{type:"required"}`, not the bare string. */
export function mapToolChoice(
  toolChoice: LanguageModelV4ToolChoice | undefined
): Anthropic.ToolChoice | undefined {
  if (!toolChoice) return undefined;
  switch (toolChoice.type) {
    case "auto":
      return { type: "auto" };
    case "none":
      return { type: "none" };
    // Core sets this on every round: "you must call one of the control tools".
    case "required":
      return { type: "any" };
    case "tool":
      return { type: "tool", name: toolChoice.toolName };
  }
}

/**
 * Sampling parameters Claude Opus 5 and its siblings removed.
 *
 * Sending any of them is a 400, so they are dropped rather than forwarded.
 * `warnings` is exactly the channel the spec provides for saying so — silently
 * ignoring a caller's `temperature` would be the worse failure.
 */
const REMOVED_SAMPLING_SETTINGS = [
  "temperature",
  "topP",
  "topK",
  "seed",
  "presencePenalty",
  "frequencyPenalty"
] as const satisfies ReadonlyArray<keyof LanguageModelV4CallOptions>;

export function collectSamplingWarnings(
  options: LanguageModelV4CallOptions
): SharedV4Warning[] {
  return REMOVED_SAMPLING_SETTINGS.filter(
    (setting) => options[setting] !== undefined
  ).map((setting) => ({
    type: "unsupported" as const,
    feature: setting,
    details:
      "Claude 4.7+ models removed sampling parameters; the value was dropped. " +
      "Steer with the prompt, or with output_config.effort."
  }));
}
