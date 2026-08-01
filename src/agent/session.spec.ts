import { describe, it, expect, vi } from "vitest";
import { appendOnce, notifyingCompaction } from "./session.js";
import {
  deterministicSessionMessage,
  sessionText,
  toModelMessages
} from "./history.js";
import { FakeSession } from "../testing/fake-session.js";
import { ConfigError, DEFAULT_CORE_CONFIG, resolveConfig } from "../config.js";
import type { SessionMessage } from "agents/experimental/memory/session";

/**
 * The session seam the phased agent loop depends on.
 *
 * Two properties carry real weight here, and both exist because a Workflow step
 * can re-run: appends are exactly-once by deterministic id, and what a caller
 * goes on to deliver is read back from storage rather than trusted from the
 * in-memory value it just produced. A step that crashed after appending and then
 * re-inferred a *different* reply must still deliver the original.
 */

const msg = (
  id: string,
  text: string,
  role: "user" | "assistant" = "assistant"
) => deterministicSessionMessage(id, role, text);

describe("appendOnce", () => {
  it("returns the durably stored text, not the text just handed in", async () => {
    const session = new FakeSession();
    await appendOnce(session, msg("task:t1:reply:final", "the original reply"));

    // The re-run: same deterministic id, different inference.
    const returned = await appendOnce(
      session,
      msg("task:t1:reply:final", "a DIFFERENT reply after retry")
    );

    // The append no-ops, and the caller is handed what is actually on disk — so
    // the Session and the delivered value can never disagree.
    expect(returned).toBe("the original reply");
    expect(session.messages).toHaveLength(1);
  });

  it("appends distinct ids normally", async () => {
    const session = new FakeSession();
    await appendOnce(session, msg("a", "first"));
    await appendOnce(session, msg("b", "second"));

    expect(session.messages.map((m) => sessionText(m))).toEqual([
      "first",
      "second"
    ]);
  });

  it("falls back to the message's own text rather than failing a phase", async () => {
    // Cannot happen — the message was just appended — but a missing echo must
    // not be the thing that fails a turn.
    const session = new FakeSession();
    vi.spyOn(session, "getMessage").mockResolvedValue(null);

    expect(await appendOnce(session, msg("x", "inline text"))).toBe(
      "inline text"
    );
  });
});

describe("notifyingCompaction", () => {
  const history = [msg("m1", "one"), msg("m2", "two"), msg("m3", "three")];
  const result = { fromMessageId: "m1", toMessageId: "m2" };

  it("hands the displaced range to the listener", async () => {
    const displaced: SessionMessage[][] = [];
    const wrapped = notifyingCompaction(
      (async () => result) as never,
      async (messages) => {
        displaced.push(messages);
      }
    );

    await wrapped(history as never, {} as never);

    // Inclusive of both ends: m1..m2 is what the summary replaced.
    expect(displaced[0].map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("returns the base function untouched when nothing is listening", () => {
    const base = (async () => result) as never;
    expect(notifyingCompaction(base, undefined)).toBe(base);
  });

  it("still compacts when the listener throws", async () => {
    // Compaction must shorten history even when whatever is listening is
    // briefly unavailable — the alternative is unbounded context because a
    // side concern is down.
    const wrapped = notifyingCompaction(
      (async () => result) as never,
      async () => {
        throw new Error("listener unavailable");
      }
    );

    await expect(wrapped(history as never, {} as never)).resolves.toEqual(
      result
    );
  });

  it("skips the notification when the displaced range is not in the history it saw", async () => {
    const onMessagesDisplaced = vi.fn();
    const wrapped = notifyingCompaction(
      (async () => ({ fromMessageId: "ghost", toMessageId: "m2" })) as never,
      onMessagesDisplaced
    );

    await wrapped(history as never, {} as never);
    expect(onMessagesDisplaced).not.toHaveBeenCalled();
  });
});

describe("history conversion", () => {
  it("keeps only user and assistant turns for the model", () => {
    const withSystem = [
      msg("u", "hello", "user"),
      msg("a", "hi", "assistant"),
      { ...msg("s", "system note"), role: "system" } as SessionMessage
    ];

    expect(toModelMessages(withSystem)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" }
    ]);
  });

  it("concatenates multi-part text and ignores non-text parts", () => {
    const multi = {
      ...msg("m", ""),
      parts: [
        { type: "text", text: "one " },
        { type: "reasoning", text: "hidden" },
        { type: "text", text: "two" }
      ]
    } as SessionMessage;

    expect(sessionText(multi)).toBe("one two");
  });
});

describe("the compaction headroom invariant", () => {
  it("holds for the shipped defaults", () => {
    const { compactAfterTokens, compactTailTokens } =
      DEFAULT_CORE_CONFIG.session;
    expect(compactAfterTokens - compactTailTokens).toBeGreaterThanOrEqual(
      10_000
    );
  });

  it("refuses a config where the floor would eat the gap", () => {
    // Below this, compaction fires on nearly every append and each firing spends
    // a summarizer call on a near-empty middle. It is a config error, not a
    // tuning preference.
    expect(() =>
      resolveConfig({ session: { compactAfterTokens: 12_000 } })
    ).toThrow(ConfigError);

    expect(() =>
      resolveConfig({ session: { compactAfterTokens: 12_000 } })
    ).toThrow(/>= 10000/);
  });

  it("accepts a lower threshold when the tail comes down with it", () => {
    const config = resolveConfig({
      session: { compactAfterTokens: 12_000, compactTailTokens: 1_000 }
    });

    expect(config.session.compactAfterTokens).toBe(12_000);
    expect(config.session.compactTailTokens).toBe(1_000);
  });

  it("refuses non-positive budgets", () => {
    expect(() => resolveConfig({ maxSubtasks: 0 })).toThrow(ConfigError);
    expect(() => resolveConfig({ mainAgentLimits: { maxTurns: -1 } })).toThrow(
      /maxTurns/
    );
  });
});
