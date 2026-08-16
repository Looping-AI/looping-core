import type { LanguageModel, ToolSet } from "ai";
import { generateText } from "ai";
import { Session } from "agents/experimental/memory/session";
import type { SessionMessage } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { sessionText } from "./history.js";

/**
 * The one continuous {@link Session} an agent Durable Object owns: soul + memory
 * + compaction, one Session per DO.
 *
 * Compaction is the one **lossy** thing this module does, so it is also the one
 * thing it announces: `onMessagesDisplaced` hands over the raw messages a
 * summary is about to replace. Core neither stores them nor knows who wants
 * them — a host wires the seam to whatever does.
 */

/**
 * The SQLite-backed host the Sessions API needs — satisfied by the Agents SDK
 * `Agent` (`this.sql`).
 */
export interface SessionHost {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

/** The subset of `Session` the agent loop drives — lets tests inject a fake. */
export interface SessionLike {
  appendMessage(
    message: SessionMessage,
    parentId?: string | null
  ): Promise<unknown> | unknown;
  getHistory(): Promise<SessionMessage[]>;
  /**
   * Read one message by id, or null. Reads the **raw stored row**, so it is
   * unaffected by compaction overlays — a message folded into a summary is still
   * readable here. That is what makes {@link appendOnce}'s read-back a reliable
   * recovery path for a round whose Workflow step re-ran.
   */
  getMessage(id: string): Promise<SessionMessage | null>;
  refreshSystemPrompt(): Promise<string>;
  tools(): Promise<ToolSet>;
  /** Compaction overlays so far — non-empty ⇒ history has been displaced. */
  getCompactions(): Promise<unknown[]>;
}

/**
 * Append a message with a deterministic id exactly once, and return the text that
 * is **durably stored** under that id.
 *
 * `Session.appendMessage` is already idempotent by id: appending an id that
 * exists is a no-op. The read-back is what matters for a re-run step — if it
 * crashed after appending and the retry re-inferred a *different* reply, the
 * append no-ops and this returns the original, durable text. The Session and the
 * value the caller goes on to deliver therefore never disagree.
 *
 * Falls back to the message's own text if the read-back returns null (it cannot,
 * having just been appended) rather than failing a round over a missing echo.
 */
export async function appendOnce(
  session: SessionLike,
  message: SessionMessage
): Promise<string> {
  await session.appendMessage(message);
  const stored = await session.getMessage(message.id);
  return stored ? sessionText(stored) : sessionText(message);
}

export interface AgentSessionOptions {
  /** Read-only identity block injected into the system prompt every turn. */
  soul: () => string | Promise<string>;
  /** Description of the writable SQLite `"memory"` scratchpad the model self-edits. */
  memoryDescription: string;
  /** Soft cap (tokens) for the `"memory"` block. */
  memoryMaxTokens: number;
  /** History token threshold that triggers compaction. */
  compactAfterTokens: number;
  /**
   * Tokens of recent history compaction keeps verbatim. Coupled to
   * {@link compactAfterTokens} — see `SessionConfig.compactTailTokens` for the
   * invariant that binds them, which `resolveConfig` enforces.
   */
  compactTailTokens: number;
  /**
   * Output-token ceiling for the summarizer call. An unbounded summary is not
   * the risk; a silently truncated one is — it becomes this caller's memory of
   * everything that scrolled out, with no way to tell it was cut short.
   */
  maxOutputTokens: number;
  /**
   * Hand over the raw messages each compaction displaces, before a summary
   * replaces them. Best-effort: a throw here must never abort compaction.
   *
   * The seam, not a policy — pass `runtime.onMessagesDisplaced` to reach every
   * installed plugin declaring the hook, or any function of your own.
   */
  onMessagesDisplaced?: (messages: SessionMessage[]) => Promise<void>;
}

type CompactFn = ReturnType<typeof createCompactFunction>;

/**
 * Wrap a compaction function so the raw messages it folds into a summary are
 * also handed to `onMessagesDisplaced` before they stop being readable as
 * history. The displaced range is `fromMessageId..toMessageId` of the result,
 * sliced from the `history` the compaction saw.
 *
 * A listener's failure is swallowed — compaction must still shorten history
 * when whatever is listening is briefly unavailable. The alternative is
 * unbounded context because a side concern is down.
 */
export function notifyingCompaction(
  base: CompactFn,
  onMessagesDisplaced?: (messages: SessionMessage[]) => Promise<void>
): CompactFn {
  if (!onMessagesDisplaced) return base;
  return async (history, options) => {
    const result = await base(history, options);
    if (result) {
      const from = history.findIndex((m) => m.id === result.fromMessageId);
      const to = history.findIndex((m) => m.id === result.toMessageId);
      if (from !== -1 && to !== -1) {
        try {
          await onMessagesDisplaced(history.slice(from, to + 1));
        } catch (err) {
          console.error("[session] displacement listener failed", err);
        }
      }
    }
    return result;
  };
}

/**
 * Build the one continuous `Session` an agent Durable Object owns: a read-only
 * `"soul"` identity block + a writable `"memory"` scratchpad, with history
 * compaction summarized by the same model. All of a caller's turns (any channel
 * or thread) accumulate into this single conversation.
 */
export function buildAgentSession(
  agent: SessionHost,
  model: LanguageModel,
  opts: AgentSessionOptions
): Session {
  const compact = notifyingCompaction(
    createCompactFunction({
      // The one boundary worth owning. `protectHead` (3) and `minTailMessages`
      // (2) keep the SDK defaults: the head is the conversation's opening and is
      // cheap, and the tail floor is a safety net rather than a budget.
      tailTokenBudget: opts.compactTailTokens,
      // Bounded like every other call: an unbounded summary is not the risk, a
      // silently truncated one is — it becomes this caller's memory of everything
      // that scrolled out, with no way to tell it was cut short.
      summarize: (prompt) =>
        generateText({
          model,
          prompt,
          maxOutputTokens: opts.maxOutputTokens
        }).then((r) => r.text)
    }),
    opts.onMessagesDisplaced
  );
  return Session.create(agent)
    .withContext("soul", { provider: { get: async () => opts.soul() } })
    .withContext("memory", {
      description: opts.memoryDescription,
      maxTokens: opts.memoryMaxTokens
    })
    .onCompaction(compact)
    .compactAfter(opts.compactAfterTokens);
}
