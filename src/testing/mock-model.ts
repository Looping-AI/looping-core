import { MockLanguageModelV3 } from "ai/test";

/**
 * Test doubles for the LLM. Lets the tool-loop / executor specs run the real
 * `generateText` machinery (tool execution, multi-step, fallback) against a
 * scripted model with no network or `AI` binding.
 */

/** Zeroed usage block satisfying the LanguageModelV3 result shape. */
const USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 }
};

export interface MockStep {
  /**
   * Assistant text for this step. On its own → finishReason "stop", which for the
   * main-agent round is a *failed* attempt: prose is not an ending there, so use
   * {@link finalReply} to script an answer. Alongside `toolCall` → the
   * intermediate content emitted before a tool call.
   */
  text?: string;
  /** Emit a tool call (finishReason "tool-calls"); may accompany `text`. */
  toolCall?: { toolName: string; input?: unknown };
  /**
   * Emit several tool calls in **one** step, which a real model does whenever it
   * decides two things at once. That is the only way to script the cases the round
   * has to arbitrate: two different endings in one step (precedence decides), or
   * the same ending twice (the tool's own `parse` decides).
   */
  toolCalls?: { toolName: string; input?: unknown }[];
}

/**
 * A step where the main agent answers the user — the `final_reply` control call.
 *
 * Scripting a bare `{ text }` instead reproduces the bug this tool exists to catch
 * (a model narrating rather than acting) and fails the attempt, which is what the
 * error-path specs use it for.
 */
export function finalReply(
  text: string,
  opts: { text?: string } = {}
): MockStep {
  return {
    ...(opts.text !== undefined ? { text: opts.text } : {}),
    toolCall: { toolName: "final_reply", input: { text } }
  };
}

function stepResult(step: MockStep) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  > = [];
  // Keep the empty-string text part so a `{ text: "" }` step still yields "".
  if (step.text !== undefined) content.push({ type: "text", text: step.text });
  const calls = [
    ...(step.toolCall ? [step.toolCall] : []),
    ...(step.toolCalls ?? [])
  ];
  for (const call of calls) {
    content.push({
      type: "tool-call",
      toolCallId: crypto.randomUUID(),
      toolName: call.toolName,
      input: JSON.stringify(call.input ?? {})
    });
  }
  const unified =
    calls.length > 0 ? ("tool-calls" as const) : ("stop" as const);
  return {
    content,
    finishReason: { unified, raw: undefined },
    usage: USAGE,
    warnings: []
  };
}

/**
 * A mock model that returns each step in sequence — one per `generateText` call.
 * Uses the function form (with our own counter) rather than the array form, whose
 * call-count indexing is off by one in this SDK version. Extra calls repeat the
 * last step.
 */
export function mockModel(...steps: MockStep[]): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => stepResult(steps[Math.min(i++, steps.length - 1)])
  });
}
