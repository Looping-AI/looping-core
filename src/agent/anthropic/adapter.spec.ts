import { describe, it, expect } from "vitest";
import AnthropicClient from "@anthropic-ai/sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { APICallError, UnsupportedFunctionalityError } from "ai";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt
} from "@ai-sdk/provider";
import { createAnthropicLanguageModel } from "./language-model.js";
import { createAnthropicModelRuntime } from "./runtime.js";
import { CredentialRejectedError } from "../errors.js";
import { isTransientAiError, nonRecoverableKind } from "../inference.js";

/**
 * The Anthropic adapter's mapping contract.
 *
 * Every case here is a **silent-corruption** bug rather than a loud one: the
 * request still type-checks, the API still answers, and the damage shows up as a
 * 400 on the *next* round, a mis-parsed tool call, or a cost regression nobody
 * attributes. That is why they are unit tests over a captured request body
 * rather than integration tests — the assertion has to be on the exact bytes
 * that go on the wire.
 */

/** Captures the request body instead of sending it, and replays a canned reply. */
function fakeClient(reply: Partial<Anthropic.Message> = {}): {
  client: Anthropic;
  bodies: Anthropic.MessageStreamParams[];
  options: Array<{ headers?: Record<string, string> }>;
} {
  const bodies: Anthropic.MessageStreamParams[] = [];
  const options: Array<{ headers?: Record<string, string> }> = [];
  const client = {
    messages: {
      // `stream`, not `create` — see the streaming note in `language-model.ts`.
      // A stub cannot catch a regression here, because the ceiling that forces
      // streaming lives inside the real SDK; `sendsHighMaxTokens` below runs a
      // real client against a stub transport for exactly that reason.
      stream: (
        body: Anthropic.MessageStreamParams,
        opts?: { headers?: Record<string, string> }
      ) => {
        bodies.push(body);
        options.push(opts ?? {});
        return {
          finalMessage: () =>
            Promise.resolve({
              id: "msg_1",
              model: "claude-opus-5",
              role: "assistant",
              type: "message",
              content: [],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 5 },
              ...reply
            } as Anthropic.Message)
        };
      }
    }
  } as unknown as Anthropic;
  return { client, bodies, options };
}

function model(
  client: Anthropic,
  overrides: Partial<Parameters<typeof createAnthropicLanguageModel>[0]> = {}
): LanguageModelV4 {
  return createAnthropicLanguageModel({
    client: () => client,
    modelId: "claude-opus-5",
    defaultMaxTokens: 4096,
    ...overrides
  });
}

const userPrompt: LanguageModelV4Prompt = [
  { role: "user", content: [{ type: "text", text: "hello" }] }
];

const call = (
  prompt: LanguageModelV4Prompt,
  extra: Partial<LanguageModelV4CallOptions> = {}
): LanguageModelV4CallOptions => ({ prompt, ...extra });

describe("thinking round-trip", () => {
  /**
   * The single most load-bearing behaviour in the adapter.
   *
   * Opus 5 runs adaptive thinking by default and rejects a *modified* thinking
   * block. Core's loop is multi-turn tool use on every round, so it replays the
   * previous assistant message every time — lose the signature and round two of
   * every task 400s, in production, on a path no single-turn test exercises.
   */
  it("carries the signature out and replays it byte-identically", async () => {
    const signature = "sig_abc123==";
    const { client } = fakeClient({
      content: [
        { type: "thinking", thinking: "let me think", signature }
      ] as Anthropic.ContentBlock[]
    });

    const first = await model(client).doGenerate(call(userPrompt));
    const reasoning = first.content.find((part) => part.type === "reasoning");
    expect(reasoning).toBeDefined();
    expect(reasoning?.providerMetadata?.anthropic?.["signature"]).toBe(
      signature
    );

    // Now replay it, exactly as the SDK would on the next turn.
    const { client: second, bodies } = fakeClient();
    await model(second).doGenerate(
      call([
        ...userPrompt,
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "let me think",
              providerOptions: { anthropic: { signature } }
            }
          ]
        }
      ])
    );

    const assistant = bodies[0]!.messages.at(-1)!;
    const block = (assistant.content as Anthropic.ContentBlockParam[])[0]!;
    expect(block).toEqual({
      type: "thinking",
      thinking: "let me think",
      signature
    });
  });

  it("drops an unsigned reasoning part rather than inventing a signature", async () => {
    const { client, bodies } = fakeClient();
    const result = await model(client).doGenerate(
      call([
        ...userPrompt,
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "unsigned" },
            { type: "text", text: "the answer" }
          ]
        }
      ])
    );

    const assistant = bodies[0]!.messages.at(-1)!;
    const types = (assistant.content as Anthropic.ContentBlockParam[]).map(
      (b) => b.type
    );
    // A fabricated signature is rejected outright; dropping is the only safe
    // move, but it must be reported so the loss is attributable.
    expect(types).toEqual(["text"]);
    expect(result.warnings.some((w) => w.type === "other")).toBe(true);
  });

  it("round-trips redacted_thinking as opaque data", async () => {
    const { client } = fakeClient({
      content: [
        { type: "redacted_thinking", data: "enc_xyz" }
      ] as Anthropic.ContentBlock[]
    });
    const result = await model(client).doGenerate(call(userPrompt));
    expect(
      result.content[0]?.providerMetadata?.anthropic?.["redactedData"]
    ).toBe("enc_xyz");
  });
});

describe("tool calls", () => {
  /**
   * The asymmetry that type-checks and corrupts: `input` is a parsed value on
   * the prompt side and a JSON **string** on the result side.
   */
  it("emits tool-call input as a JSON string", async () => {
    const { client } = fakeClient({
      content: [
        { type: "tool_use", id: "tu_1", name: "sb_exec", input: { cmd: "ls" } }
      ] as Anthropic.ContentBlock[]
    });
    const result = await model(client).doGenerate(call(userPrompt));
    const toolCall = result.content.find((part) => part.type === "tool-call");
    expect(toolCall).toMatchObject({
      toolCallId: "tu_1",
      toolName: "sb_exec",
      input: '{"cmd":"ls"}'
    });
    expect(typeof (toolCall as { input: unknown }).input).toBe("string");
  });

  it("sends prompt-side tool-call input as a parsed object", async () => {
    const { client, bodies } = fakeClient();
    await model(client).doGenerate(
      call([
        ...userPrompt,
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "tu_1",
              toolName: "sb_exec",
              input: { cmd: "ls" }
            }
          ]
        }
      ])
    );
    const block = (
      bodies[0]!.messages.at(-1)!.content as Anthropic.ContentBlockParam[]
    )[0] as Anthropic.ToolUseBlockParam;
    expect(block.input).toEqual({ cmd: "ls" });
  });

  /** Anthropic has no `tool` role — results ride in a user turn. */
  it("maps the tool role onto a user turn of tool_result blocks", async () => {
    const { client, bodies } = fakeClient();
    await model(client).doGenerate(
      call([
        ...userPrompt,
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "tu_1",
              toolName: "sb_exec",
              input: {}
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tu_1",
              toolName: "sb_exec",
              output: { type: "text", value: "total 0" }
            }
          ]
        }
      ])
    );

    const last = bodies[0]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect((last.content as Anthropic.ContentBlockParam[])[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "total 0"
    });
  });

  it("flags an error tool result", async () => {
    const { client, bodies } = fakeClient();
    await model(client).doGenerate(
      call([
        ...userPrompt,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tu_1",
              toolName: "sb_exec",
              output: { type: "error-text", value: "boom" }
            }
          ]
        }
      ])
    );
    const content = bodies[0]!.messages.at(-1)!
      .content as Anthropic.ContentBlockParam[];
    const block = content.find(
      (b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result"
    );
    expect(block?.is_error).toBe(true);
  });

  /**
   * Reachable only when a user turn sits between the tool call and its results,
   * which the merge then folds together. Anthropic requires `tool_result` blocks
   * to lead the turn, so text that merged in behind them must not displace them.
   */
  it("hoists tool_result blocks ahead of merged text", async () => {
    const { client, bodies } = fakeClient();
    await model(client).doGenerate(
      call([
        ...userPrompt,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tu_1",
              toolName: "sb_exec",
              output: { type: "text", value: "total 0" }
            }
          ]
        }
      ])
    );
    const content = bodies[0]!.messages.at(-1)!
      .content as Anthropic.ContentBlockParam[];
    expect(content.map((b) => b.type)).toEqual(["tool_result", "text"]);
  });

  /**
   * The regression that cost a production task.
   *
   * Anthropic validates `tool_use.id` against `^[a-zA-Z0-9_-]+$`, and core used
   * to synthesise colon-separated ids when it reconstructed an earlier round's
   * delegation. The result was a `400 invalid_request_error` on replayed
   * history — deterministic, so every retry and every fallback re-sent the same
   * poisoned messages and failed identically.
   *
   * Asserted on both halves in one request, because a sanitiser applied to only
   * one side trades a 400 about the id for a 400 about the mismatch.
   */
  it("sanitises unsafe tool ids on both the call and its result", async () => {
    const { client, bodies } = fakeClient();
    const unsafe = "task:abc-123:round:1:delegate";
    await model(client).doGenerate(
      call([
        ...userPrompt,
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: unsafe,
              toolName: "delegate",
              input: {}
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: unsafe,
              toolName: "delegate",
              output: { type: "text", value: "done" }
            }
          ]
        }
      ])
    );

    const messages = bodies[0]!.messages;
    const use = (
      messages.at(-2)!.content as Anthropic.ContentBlockParam[]
    )[0] as Anthropic.ToolUseBlockParam;
    const result = (
      messages.at(-1)!.content as Anthropic.ContentBlockParam[]
    )[0] as Anthropic.ToolResultBlockParam;

    expect(use.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(use.id).toBe("task_abc-123_round_1_delegate");
    // The pair has to agree, or the request is malformed a second way.
    expect(result.tool_use_id).toBe(use.id);
  });

  /** A safe id must survive untouched — the sanitiser is a backstop, not a rewrite. */
  it("leaves an already-safe tool id alone", async () => {
    const { client, bodies } = fakeClient();
    await model(client).doGenerate(
      call([
        ...userPrompt,
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "toolu_01A-b_2",
              toolName: "sb_exec",
              input: {}
            }
          ]
        }
      ])
    );
    const block = (
      bodies[0]!.messages.at(-1)!.content as Anthropic.ContentBlockParam[]
    )[0] as Anthropic.ToolUseBlockParam;
    expect(block.id).toBe("toolu_01A-b_2");
  });

  /** Core sets `toolChoice: {type:"required"}` on literally every round. */
  it("maps required tool choice to Anthropic's `any`", async () => {
    const { client, bodies } = fakeClient();
    await model(client).doGenerate(
      call(userPrompt, {
        toolChoice: { type: "required" },
        tools: [
          {
            type: "function",
            name: "final_reply",
            inputSchema: { type: "object" as const, properties: {} }
          }
        ]
      })
    );
    expect(bodies[0]!.tool_choice).toEqual({ type: "any" });
  });
});

describe("removed sampling parameters", () => {
  /**
   * These 400 on Opus 5. Forwarding them breaks every request; dropping them
   * silently hides a caller's intent. The spec's `warnings` array is the channel
   * that exists for exactly this.
   */
  it("drops them and reports each as an unsupported warning", async () => {
    const { client, bodies } = fakeClient();
    const result = await model(client).doGenerate(
      call(userPrompt, { temperature: 0.7, topP: 0.9, topK: 5, seed: 1 })
    );

    const body = bodies[0]! as unknown as Record<string, unknown>;
    for (const key of ["temperature", "top_p", "top_k", "seed"]) {
      expect(body[key]).toBeUndefined();
    }
    expect(
      result.warnings
        .filter((w) => w.type === "unsupported")
        .map((w) => (w as { feature: string }).feature)
        .sort()
    ).toEqual(["seed", "temperature", "topK", "topP"]);
  });
});

describe("reasoning effort", () => {
  /**
   * The spec's `reasoning` union and Anthropic's `output_config.effort` overlap
   * but are not equal, and the gap is a 400 rather than a type error. This used
   * to bridge them with a cast, which is exactly what stopped the compiler from
   * saying so.
   */
  it("passes through the levels both vocabularies share", async () => {
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      const { client, bodies } = fakeClient();
      await model(client).doGenerate(call(userPrompt, { reasoning: effort }));
      expect(bodies[0]!.output_config).toEqual({ effort });
    }
  });

  /**
   * `max` is the asymmetry in the other direction: Anthropic defines it, the
   * spec's per-call `reasoning` does not. So it is only reachable as the
   * runtime's own default, which is why `AnthropicModelDeps.effort` has a wider
   * type than `LanguageModelV4CallOptions.reasoning`.
   */
  it("accepts `max` as a runtime default", async () => {
    const { client, bodies } = fakeClient();
    await model(client, { effort: "max" }).doGenerate(call(userPrompt));
    expect(bodies[0]!.output_config).toEqual({ effort: "max" });
  });

  it("maps `minimal` down rather than dropping it", async () => {
    // Dropping would let the API default of `high` stand — the opposite of what
    // a caller asking for minimal thinking wants.
    const { client, bodies } = fakeClient();
    const result = await model(client).doGenerate(
      call(userPrompt, { reasoning: "minimal" })
    );

    expect(bodies[0]!.output_config).toEqual({ effort: "low" });
    expect(
      result.warnings.some(
        (w) => w.type === "unsupported" && w.feature === "reasoning"
      )
    ).toBe(true);
  });

  it("says nothing for provider-default and none", async () => {
    for (const effort of ["provider-default", "none"] as const) {
      const { client, bodies } = fakeClient();
      await model(client).doGenerate(call(userPrompt, { reasoning: effort }));
      expect(bodies[0]!.output_config).toBeUndefined();
    }
  });

  it("lets a per-call effort override the runtime default", async () => {
    const { client, bodies } = fakeClient();
    await model(client, { effort: "xhigh" }).doGenerate(
      call(userPrompt, { reasoning: "low" })
    );
    expect(bodies[0]!.output_config).toEqual({ effort: "low" });
  });
});

describe("malformed prompts the API would reject", () => {
  /**
   * Anthropic requires the conversation to open on a `user` turn. A leading user
   * message whose only part is empty text maps to nothing and is dropped, which
   * silently leaves an `assistant` turn first.
   */
  it("inserts a user turn when the first mapped turn is not one", async () => {
    const { client, bodies } = fakeClient();
    const result = await model(client).doGenerate(
      call([
        { role: "user", content: [{ type: "text", text: "" }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] }
      ])
    );

    expect(bodies[0]!.messages[0]!.role).toBe("user");
    expect(result.warnings.some((w) => w.type === "other")).toBe(true);
  });

  /**
   * Every `tool_use` needs a `tool_result` in the turn that follows it. A `tool`
   * message whose parts were all unmappable is dropped, orphaning the call
   * before it while the conversation carries on — the silent case, because
   * nothing about the remaining turns looks wrong.
   */
  it("synthesises a result for a tool call whose result was lost", async () => {
    const { client, bodies } = fakeClient();
    const result = await model(client).doGenerate(
      call([
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "search",
              input: { q: "x" }
            }
          ]
        },
        // Nothing here maps to a `tool_result`, so the whole turn is dropped.
        {
          role: "tool",
          content: [
            {
              type: "text",
              text: "not a tool-result part"
            } as unknown as never
          ]
        },
        { role: "user", content: [{ type: "text", text: "carry on" }] }
      ])
    );

    const last = bodies[0]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    const blocks = last.content as Anthropic.ContentBlockParam[];
    // Leading, not appended: `tool_result` must come first in its turn.
    expect(blocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "call_1",
      is_error: true
    });
    expect(blocks[1]).toMatchObject({ type: "text", text: "carry on" });
    expect(result.warnings.some((w) => w.type === "other")).toBe(true);
  });

  /**
   * The mirror of the above: a conversation *ending* on an unanswered
   * `tool_use` is an assistant prefill, a shape core never produces, and it is
   * deliberately left untouched rather than repaired on a guess.
   */
  it("leaves a trailing unanswered tool call alone", async () => {
    const { client, bodies } = fakeClient();
    await model(client).doGenerate(
      call([
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "search",
              input: { q: "x" }
            }
          ]
        }
      ])
    );

    expect(bodies[0]!.messages.at(-1)!.role).toBe("assistant");
  });

  it("leaves a properly answered tool call alone", async () => {
    const { client, bodies } = fakeClient();
    await model(client).doGenerate(
      call([
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "search",
              input: { q: "x" }
            }
          ]
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "search",
              output: { type: "text", value: "found" }
            }
          ]
        }
      ])
    );

    const blocks = bodies[0]!.messages.at(-1)!
      .content as Anthropic.ContentBlockParam[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "call_1",
      content: "found"
    });
    expect(blocks[0]).not.toHaveProperty("is_error");
  });
});

describe("finish reasons and usage", () => {
  it("maps refusal without assuming content[0] exists", async () => {
    // A refusal is a normal 200 with an empty content array — code that reaches
    // straight for content[0] throws here rather than surfacing the refusal.
    const { client } = fakeClient({ content: [], stop_reason: "refusal" });
    const result = await model(client).doGenerate(call(userPrompt));
    expect(result.content).toEqual([]);
    expect(result.finishReason).toEqual({
      unified: "content-filter",
      raw: "refusal"
    });
  });

  it.each([
    ["end_turn", "stop"],
    ["max_tokens", "length"],
    ["tool_use", "tool-calls"],
    ["pause_turn", "other"]
  ] as const)("maps %s to %s and keeps the raw value", async (raw, unified) => {
    const { client } = fakeClient({ stop_reason: raw });
    const result = await model(client).doGenerate(call(userPrompt));
    expect(result.finishReason).toEqual({ unified, raw });
  });

  /**
   * `input_tokens` is the *uncached remainder*, not the prompt size. Reporting
   * it as the total is what makes a well-cached agent look like it is barely
   * sending any context.
   */
  it("totals input tokens across cached and uncached", async () => {
    const { client } = fakeClient({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50
      } as Anthropic.Usage
    });
    const result = await model(client).doGenerate(call(userPrompt));
    expect(result.usage.inputTokens).toMatchObject({
      total: 1050,
      noCache: 100,
      cacheRead: 900,
      cacheWrite: 50
    });
    expect(result.usage.outputTokens.total).toBe(20);
  });
});

describe("prompt caching", () => {
  const tools = [
    {
      type: "function" as const,
      name: "a",
      inputSchema: { type: "object" as const }
    },
    {
      type: "function" as const,
      name: "b",
      inputSchema: { type: "object" as const }
    }
  ];
  const withSystem: LanguageModelV4Prompt = [
    { role: "system", content: "you are a coder" },
    ...userPrompt
  ];

  it("marks the last tool and the last system block, and honours the 1h TTL", async () => {
    const { client, bodies } = fakeClient();
    await model(client, { cache: "1h" }).doGenerate(
      call(withSystem, { tools })
    );

    const body = bodies[0]!;
    const sent = body.tools as Anthropic.Tool[];
    expect(sent[0]!.cache_control).toBeUndefined();
    expect(sent[1]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    const system = body.system as Anthropic.TextBlockParam[];
    expect(system.at(-1)!.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h"
    });
  });

  it("defaults to the 5m TTL, which serialises without a ttl field", async () => {
    const { client, bodies } = fakeClient();
    await model(client).doGenerate(call(withSystem, { tools }));
    const system = bodies[0]!.system as Anthropic.TextBlockParam[];
    expect(system.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("places no breakpoints when caching is disabled", async () => {
    const { client, bodies } = fakeClient();
    await model(client, { cache: false }).doGenerate(
      call(withSystem, { tools })
    );
    expect(countBreakpoints(bodies[0]!)).toBe(0);
  });

  /**
   * The 20-block lookback trap. A breakpoint searches back at most 20 content
   * blocks for a live entry; one busy round of a tool-calling agent adds far
   * more than that, so without an anchor partway back the next request silently
   * misses and re-bills the whole prefix.
   */
  it("adds a second rolling breakpoint once the tail outruns the lookback window", async () => {
    const long: LanguageModelV4Prompt = [
      ...withSystem,
      ...Array.from({ length: 30 }, (_, i) => ({
        role: "assistant" as const,
        content: [{ type: "text" as const, text: `step ${i}` }]
      }))
    ];
    const { client, bodies } = fakeClient();
    await model(client).doGenerate(call(long, { tools }));

    const messageBreakpoints = bodies[0]!.messages.flatMap((m) =>
      (m.content as Anthropic.ContentBlockParam[]).filter(
        (b) => (b as { cache_control?: unknown }).cache_control !== undefined
      )
    );
    expect(messageBreakpoints).toHaveLength(2);
  });

  /** Four is a hard API limit; a fifth is a 400. */
  it("never exceeds the four-breakpoint budget", async () => {
    const long: LanguageModelV4Prompt = [
      ...withSystem,
      ...Array.from({ length: 60 }, (_, i) => ({
        role: "assistant" as const,
        content: [{ type: "text" as const, text: `step ${i}` }]
      }))
    ];
    const { client, bodies } = fakeClient();
    await model(client).doGenerate(call(long, { tools }));
    expect(countBreakpoints(bodies[0]!)).toBeLessThanOrEqual(4);
  });

  /**
   * Tools render at position 0, so any drift in their serialisation invalidates
   * everything after it. This is the cheapest possible guard against a future
   * change that iterates a `Set` or a `Record` in nondeterministic order.
   */
  it("renders byte-identical tool JSON across calls", async () => {
    const { client, bodies } = fakeClient();
    const m = model(client);
    await m.doGenerate(call(withSystem, { tools }));
    await m.doGenerate(call(withSystem, { tools }));
    expect(JSON.stringify(bodies[0]!.tools)).toBe(
      JSON.stringify(bodies[1]!.tools)
    );
  });
});

function countBreakpoints(body: Anthropic.MessageStreamParams): number {
  const hasControl = (b: unknown) =>
    (b as { cache_control?: unknown } | null)?.cache_control !== undefined;
  const system = Array.isArray(body.system)
    ? body.system.filter(hasControl).length
    : 0;
  const tools = (body.tools ?? []).filter(hasControl).length;
  const messages = body.messages.flatMap((m) =>
    (m.content as Anthropic.ContentBlockParam[]).filter(hasControl)
  ).length;
  return system + tools + messages;
}

/**
 * The one place a real `Anthropic` client is constructed, against a stub
 * transport rather than a stub client.
 *
 * Every other test here injects a fake `messages` object, which is right for
 * assertions about mapping — and blind to anything the SDK itself enforces
 * before a request leaves the process. That blindness shipped: the adapter
 * called `messages.create`, and the SDK rejects a non-streaming request whose
 * `max_tokens` implies more than ten minutes of generation, so the coder's
 * 32,000-token ceiling threw on round 0 of every task, primary and fallback
 * alike, without one byte reaching the network.
 */
describe("transport", () => {
  /** A complete, minimal SSE message: start, one text block, stop. */
  function sse(): Response {
    const event = (type: string, data: unknown) =>
      `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    return new Response(
      event("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 }
        }
      }) +
        event("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" }
        }) +
        event("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" }
        }) +
        event("content_block_stop", { type: "content_block_stop", index: 0 }) +
        event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 }
        }) +
        event("message_stop", { type: "message_stop" }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  }

  function realClient(): {
    client: AnthropicClient;
    sent: Array<Record<string, unknown>>;
  } {
    const sent: Array<Record<string, unknown>> = [];
    const client = new AnthropicClient({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: async (_url: unknown, init?: { body?: unknown }) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return sse();
      }
    } as ConstructorParameters<typeof AnthropicClient>[0]);
    return { client, sent };
  }

  it("sends a max_tokens the SDK would refuse to send unstreamed", async () => {
    const { client, sent } = realClient();

    const result = await model(client).doGenerate(
      call(userPrompt, { maxOutputTokens: 32_000 })
    );

    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(sent[0]?.max_tokens).toBe(32_000);
    expect(sent[0]?.stream).toBe(true);
  });

  /**
   * Pins the ceiling this adapter routes around: `(60 * 60 * max_tokens) /
   * 128_000 > 600` seconds, so anything above 21,333 tokens. If the SDK ever
   * drops the guard, this fails and the note above can be revisited.
   */
  /**
   * `env.AI.gateway(id).getUrl()` is async. Passing the unresolved promise as
   * `baseURL` type-checks only behind a cast, and then every request dies deep
   * in the SDK on `baseURL.endsWith is not a function` — a message that names
   * neither the gateway nor the thunk. This drives the real runtime, so the
   * client is built the way production builds it.
   */
  it("resolves an async gateway URL before it reaches the SDK", async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      seen.push(String(input));
      return sse();
    }) as typeof fetch;

    try {
      const runtime = createAnthropicModelRuntime({
        baseUrl: async () =>
          "https://gateway.example/v1/acct/default/anthropic",
        authToken: () => "token",
        config: {
          chatModelId: "claude-opus-5",
          fallbackChatModelId: "claude-sonnet-5",
          aiGatewayId: "default",
          aiGatewayProvider: "anthropic",
          maxOutputTokens: 32_000,
          reasoningEffort: "high",
          maxRetries: 0
        }
      });

      const result = await (
        runtime.createModelPair().primary() as LanguageModelV4
      ).doGenerate(call(userPrompt));

      expect(result.content).toEqual([{ type: "text", text: "ok" }]);
      expect(seen[0]).toBe(
        "https://gateway.example/v1/acct/default/anthropic/v1/messages"
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  /**
   * The credential is resolved per request, never captured once.
   *
   * `authToken` does not have to be a stored secret. A deployment that routes
   * through an authenticated intermediary signs a short-lived token per call
   * instead — so a client that bakes the credential in at construction and is
   * then reused works for exactly one token lifetime. The failure that produces
   * is the worst kind: the first request succeeds, breakage begins minutes
   * later, only under sustained load, and the `401` names the wrong secret.
   *
   * This is the regression test for that. It is also why `authToken` is
   * async-capable — signing is.
   */
  it("resolves the credential on every request, not once", async () => {
    const seen: (string | null)[] = [];
    let minted = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return sse();
    }) as typeof fetch;

    try {
      const runtime = createAnthropicModelRuntime({
        baseUrl: async () => "https://gateway.example/custom-looping-anthropic",
        // Async, and a different value each call — the shape a per-request
        // signed token actually has.
        authToken: async () => `minted-${++minted}`,
        config: {
          chatModelId: "claude-opus-5",
          fallbackChatModelId: "claude-sonnet-5",
          aiGatewayId: "default",
          aiGatewayProvider: "custom-looping-anthropic",
          maxOutputTokens: 4096,
          reasoningEffort: "high",
          maxRetries: 0
        }
      });

      const primary = runtime.createModelPair().primary() as LanguageModelV4;
      await primary.doGenerate(call(userPrompt));
      await primary.doGenerate(call(userPrompt));

      expect(seen).toEqual(["Bearer minted-1", "Bearer minted-2"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  /**
   * Rebuilding the client per request must not mean re-resolving the gateway
   * URL per request: that one *is* a binding call, and it is the reason the
   * memo exists at all.
   */
  it("resolves the gateway URL once and reuses it across requests", async () => {
    let resolved = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => sse()) as typeof fetch;

    try {
      const runtime = createAnthropicModelRuntime({
        baseUrl: async () => {
          resolved += 1;
          return "https://gateway.example/custom-looping-anthropic";
        },
        authToken: () => "token",
        config: {
          chatModelId: "claude-opus-5",
          fallbackChatModelId: "claude-sonnet-5",
          aiGatewayId: "default",
          aiGatewayProvider: "custom-looping-anthropic",
          maxOutputTokens: 4096,
          reasoningEffort: "high",
          maxRetries: 0
        }
      });

      const pair = runtime.createModelPair();
      await (pair.primary() as LanguageModelV4).doGenerate(call(userPrompt));
      await (pair.primary() as LanguageModelV4).doGenerate(call(userPrompt));
      await (pair.fallback() as LanguageModelV4).doGenerate(call(userPrompt));

      expect(resolved).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  /**
   * A gateway with Authenticated Gateway enabled rejects anything without
   * `cf-aig-authorization` — before the provider sees it, and without writing a
   * line to its own call log. Two independent authorities on one request, so
   * `Authorization` (the model credential) is not a substitute for it.
   */
  it.each([
    ["sends the gateway token when one is configured", "gw-token", true],
    ["omits the header entirely when none is configured", undefined, false]
  ] as const)("%s", async (_name, token, expected) => {
    const seen: Headers[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return sse();
    }) as typeof fetch;

    try {
      const runtime = createAnthropicModelRuntime({
        baseUrl: async () => "https://gateway.example/anthropic",
        authToken: () => "claude-token",
        ...(token ? { gatewayToken: () => token } : {}),
        config: {
          chatModelId: "claude-opus-5",
          fallbackChatModelId: "claude-sonnet-5",
          aiGatewayId: "default",
          aiGatewayProvider: "anthropic",
          maxOutputTokens: 4096,
          reasoningEffort: "high",
          maxRetries: 0
        }
      });

      await (runtime.createModelPair().primary() as LanguageModelV4).doGenerate(
        call(userPrompt)
      );

      expect(seen[0]?.has("cf-aig-authorization")).toBe(expected);
      if (expected)
        expect(seen[0]?.get("cf-aig-authorization")).toBe(`Bearer ${token}`);
      // The provider's own credential rides separately, either way.
      expect(seen[0]?.get("authorization")).toBe("Bearer claude-token");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("documents the non-streaming ceiling it exists to avoid", () => {
    const { client } = realClient();

    // Synchronous, not a rejected promise: the guard runs before the request
    // promise exists, which is why nothing downstream could have retried past
    // it either.
    expect(() =>
      client.messages.create({
        model: "claude-opus-5",
        max_tokens: 32_000,
        messages: [{ role: "user", content: "hello" }]
      })
    ).toThrow(/Streaming is required/);
  });
});

describe("errors", () => {
  it("throws a named error rather than half-implementing streaming", () => {
    const { client } = fakeClient();
    // The spec's own error, so a caller reaching for `streamText` gets the
    // vocabulary every other provider uses rather than one of ours.
    expect(() =>
      model(client).doStream({} as LanguageModelV4CallOptions)
    ).toThrow(UnsupportedFunctionalityError);
  });

  /** A client whose request fails the way the SDK fails one: `status` + body. */
  function rejectingClient(status: number, body?: unknown): Anthropic {
    return {
      messages: {
        stream: () => ({
          finalMessage: () =>
            Promise.reject(
              Object.assign(new Error(`${status} Unauthorized`), {
                status,
                error: body
              })
            )
        })
      }
    } as unknown as Anthropic;
  }

  it("converts a 401 into a credential error", async () => {
    await expect(
      model(rejectingClient(401)).doGenerate(call(userPrompt))
    ).rejects.toSatisfy(CredentialRejectedError.isInstance);
  });

  /**
   * Every authority on the path answers `401`, and only the body says which one
   * did. Reading it wrong is not a cosmetic problem: it is the difference
   * between telling an operator to rotate the gateway token and telling them to
   * rotate a Claude token that was working the whole time.
   *
   * Each shape is matched on its name **and**, separately, its numeric code, so
   * a rename on either side is caught here rather than degrading to `unknown`
   * in production.
   */
  it.each([
    [
      "gateway",
      { name: "AiGatewayError", internalCode: 2009, message: "Unauthorized" },
      "gateway"
    ],
    ["gateway by code alone", { internalCode: 2009 }, "gateway"],
    ["gateway by name alone", { name: "AiGatewayError" }, "gateway"],
    [
      "provider",
      { type: "error", error: { type: "authentication_error" } },
      "provider"
    ],
    ["neither", { something: "else" }, "unknown"],
    ["no body at all", undefined, "unknown"]
  ] as const)("attributes a 401 body of %s to %s", async (_n, body, source) => {
    await expect(
      model(rejectingClient(401, body)).doGenerate(call(userPrompt))
    ).rejects.toMatchObject({ name: "CredentialRejectedError", source });
  });

  /**
   * The third authority, which core does not recognise and must not.
   *
   * A deployment may put an authenticated intermediary between the gateway and
   * Anthropic; only that deployment knows what its refusal looks like, and
   * hardcoding one particular proxy's error body here would be the deployment
   * policy this package does not ship. It matters because the remedy differs:
   * a proxy that mints its caller credential per request has no secret to
   * rotate, so reporting its 401 as `credential` sends an operator to replace a
   * token that was working.
   */
  it("lets a deployment classify an authority core has never heard of", async () => {
    await expect(
      model(rejectingClient(401, { name: "SomeProxyError", code: 4010 }), {
        classifyAuthFailure: (body) =>
          (body as { name?: string })?.name === "SomeProxyError"
            ? "proxy"
            : undefined
      }).doGenerate(call(userPrompt))
    ).rejects.toMatchObject({
      name: "CredentialRejectedError",
      source: "proxy"
    });
  });

  /**
   * The hook is consulted first but is not obliged to answer. Declining has to
   * leave the built-in shapes intact, or a deployment that recognises only its
   * own proxy would lose the gateway/provider split it never asked to replace.
   */
  it("falls through to the built-in shapes when the classifier declines", async () => {
    await expect(
      model(rejectingClient(401, { name: "AiGatewayError" }), {
        classifyAuthFailure: () => undefined
      }).doGenerate(call(userPrompt))
    ).rejects.toMatchObject({
      name: "CredentialRejectedError",
      source: "gateway"
    });
  });

  /** The kind is what crosses RPC; the source never leaves this module. */
  it.each([
    ["provider", "credential"],
    ["gateway", "gateway-credential"],
    ["proxy", "proxy-credential"],
    ["unknown", "unknown-credential"]
  ] as const)("maps source %s to kind %s", (source, kind) => {
    expect(
      nonRecoverableKind(
        new CredentialRejectedError("401", { status: 401, source })
      )
    ).toBe(kind);
  });

  /**
   * The classification that keeps an expired token from burning the Workflow's
   * retry budget and then the fallback slot on the same rejected credential.
   */
  it("classifies a credential error as non-transient", () => {
    const err = new CredentialRejectedError("rate limit adjacent prose", {
      status: 401
    });
    expect(isTransientAiError(err)).toBe(false);
  });

  it("leaves genuine transient errors alone", () => {
    expect(isTransientAiError(new Error("service unavailable"))).toBe(true);
  });

  /**
   * A rejection that is *not* a credential has to arrive as an `APICallError`,
   * or nothing downstream can act on it.
   *
   * Two consumers depend on this shape and both were silently inert while the
   * adapter rethrew raw SDK errors: `ai`'s retry gates on
   * `APICallError.isInstance(err) && err.isRetryable`, and
   * `isTransientAiError` prefers the same structured signal over scanning the
   * message for the word "rate limit". A 429 therefore skipped the backoff
   * entirely, spent the fallback slot on a model behind the same credential,
   * and made the Workflow retry the whole round.
   */
  it("maps a non-credential rejection to a retryable APICallError", async () => {
    const client = {
      messages: {
        stream: () => ({
          finalMessage: () =>
            Promise.reject(
              Object.assign(new Error("429 Wholesale Rate limited"), {
                status: 429,
                headers: new Headers({ "Retry-After": "7" }),
                error: { type: "error", error: { type: "rate_limit_error" } }
              })
            )
        })
      }
    } as unknown as Anthropic;

    const err = await Promise.resolve(
      model(client).doGenerate(call(userPrompt))
    ).catch((e: unknown) => e);

    expect(APICallError.isInstance(err)).toBe(true);
    const api = err as APICallError;
    expect(api.statusCode).toBe(429);
    // `isRetryable` is derived from the status rather than passed, so this also
    // pins that we did not accidentally override it.
    expect(api.isRetryable).toBe(true);
    // Bracket access on a plain object, which is how `getRetryDelayInMs` reads
    // it — a `Headers` instance here answers `undefined` and the provider's own
    // backoff hint is silently discarded.
    expect(api.responseHeaders?.["retry-after"]).toBe("7");
    expect(isTransientAiError(err)).toBe(true);
  });

  /** A 401 must not become a retryable APICallError on its way past. */
  it("keeps a credential rejection out of the retryable path", async () => {
    const err = await Promise.resolve(
      model(rejectingClient(401)).doGenerate(call(userPrompt))
    ).catch((e: unknown) => e);

    expect(APICallError.isInstance(err)).toBe(false);
    expect(CredentialRejectedError.isInstance(err)).toBe(true);
  });

  /**
   * A 403 is authorization, not authentication, and the difference decides
   * whether the fallback slot is worth spending.
   *
   * Anthropic answers `permission_error` when a perfectly valid credential lacks
   * access to *this* model — an org that has not enabled it, say. Calling that a
   * dead credential is wrong twice over: it sends an operator to rotate a
   * working token, and it skips the one thing that could still answer, since
   * the fallback is a **different model** and may well be permitted.
   */
  it("treats a 403 permission error as a normal failure the fallback can answer", async () => {
    const err = await Promise.resolve(
      model(
        rejectingClient(403, {
          type: "error",
          error: { type: "permission_error" }
        })
      ).doGenerate(call(userPrompt))
    ).catch((e: unknown) => e);

    expect(CredentialRejectedError.isInstance(err)).toBe(false);
    expect(nonRecoverableKind(err)).toBeUndefined();
    // An APICallError, so the ladder burns this slot and moves on — which is
    // exactly the behaviour a model-specific denial wants.
    expect(APICallError.isInstance(err)).toBe(true);
    expect((err as APICallError).statusCode).toBe(403);
  });

  /** A 403 that *does* name a refused credential still stops the ladder. */
  it("still stops on a 403 that names a refused credential", async () => {
    await expect(
      model(rejectingClient(403, { name: "AiGatewayError" })).doGenerate(
        call(userPrompt)
      )
    ).rejects.toMatchObject({
      name: "CredentialRejectedError",
      source: "gateway"
    });
  });

  /**
   * A transport failure never reaches a server, so it carries no status — and
   * every retry path here keys on one.
   *
   * The SDK raises `APIConnectionError` / `APIConnectionTimeoutError` for these
   * with `status: undefined`. Left unmapped, `ai`'s retry does not fire
   * (`isRetryable` is derived from a status that does not exist), the client's
   * own retries are off, and `isTransientAiError`'s fragments do not match
   * "Connection error." — so a blip burned the primary, burned the fallback, and
   * failed the task as `exhausted`. It has to arrive retryable.
   */
  it.each([["Connection error."], ["Request timed out."]])(
    "maps the status-less transport failure %s to a retryable error",
    async (message) => {
      // The shape `APIError.generate` produces with no status and no headers:
      // `status`, `headers` and `type` are all assigned, all undefined.
      const client = {
        messages: {
          stream: () => ({
            finalMessage: () =>
              Promise.reject(
                Object.assign(new Error(message), {
                  status: undefined,
                  headers: undefined,
                  error: undefined,
                  type: null
                })
              )
          })
        }
      } as unknown as Anthropic;

      const err = await Promise.resolve(
        model(client).doGenerate(call(userPrompt))
      ).catch((e: unknown) => e);

      expect(APICallError.isInstance(err)).toBe(true);
      expect((err as APICallError).isRetryable).toBe(true);
      // Which is what puts it back on both retry paths: the SDK's own, and the
      // Workflow step's via the transient classifier.
      expect(isTransientAiError(err)).toBe(true);
    }
  );

  /**
   * The other half of that rule. A programming error thrown from the same `try`
   * has no business being reported as a retryable provider failure — retrying a
   * `TypeError` just spends the budget reproducing it.
   */
  it("leaves a non-SDK error alone rather than calling it retryable", async () => {
    const client = {
      messages: {
        stream: () => ({
          finalMessage: () =>
            Promise.reject(new TypeError("x is not a function"))
        })
      }
    } as unknown as Anthropic;

    const err = await Promise.resolve(
      model(client).doGenerate(call(userPrompt))
    ).catch((e: unknown) => e);

    expect(APICallError.isInstance(err)).toBe(false);
    expect(err).toBeInstanceOf(TypeError);
  });
});
