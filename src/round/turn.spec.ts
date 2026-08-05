import { describe, it, expect } from "vitest";
import { z } from "zod";
import { makeSubtaskTypes } from "../subtasks/index.js";
import { newTurnBudget } from "../agent/index.js";
import type { ModelPair } from "../agent/index.js";
import type { CompositionBranch } from "../subtasks/index.js";
import type { SubtaskTypeSpec } from "../contract/recipe.js";
import { FakeSession } from "../testing/fake-session.js";
import { finalReply, mockModel } from "../testing/mock-model.js";
import { TEST_MODELS } from "../testing/fixtures.js";
import {
  buildTurnInstructions,
  joinSuccessfulBranches,
  renderTurnMessages,
  runTurn,
  type RunTurnArgs
} from "./turn.js";
import type { RoundPolicy } from "./policy.js";

/**
 * The round loop.
 *
 * ## Why this file is here, and where it came from
 *
 * These assertions used to live in `looping-starter` as
 * `test/round-agent/turn.spec.ts`, back when the loop itself did. Moving the
 * loop into core deleted them and re-landed nothing, so the entire
 * primary→fallback→repair ladder shipped from a published package with no
 * coverage at all — and the suite stayed green throughout, because the tests
 * left with the code they covered. That is the failure mode a refactor is most
 * prone to and least likely to notice.
 *
 * They are restored here, adapted to the one thing that genuinely changed:
 * prompt copy is now injected as a {@link RoundPolicy} rather than written
 * inline, so the fixture below supplies it the way an agent does.
 *
 * What they pin is the part with no second chance at runtime: a round that
 * reaches no ending must cost the budget it spent, fall back to the other
 * model, and — when both models fail — still deliver durable branch results
 * rather than throwing away work the user asked for and paid for.
 */

/**
 * A stand-in for a plugin-declared type. Core cannot import the starter's, and
 * should not: what these specs need is *a* type with a name, so the contract
 * can be checked for naming exactly the installed ones.
 */
const generalType: SubtaskTypeSpec = {
  key: "general",
  description: "General research or writing work.",
  params: z.object({}),
  capability: "You can delegate general work.",
  recipe: {
    key: "general",
    version: 1,
    soul: "You are a general subagent.",
    toolFamilies: [],
    enabled: true,
    limits: {},
    historyWindow: 10,
    reportMetrics: false
  }
};

const types = makeSubtaskTypes([generalType]);

/**
 * Policy in the shape the interface documents: every prompt string opens on a
 * blank line, because the composition concatenates these directly onto the soul
 * and the caller context and adds no separator of its own.
 */
const policy: RoundPolicy = {
  roundContract: ({ typeKeys, maxSubtasks }) => `

# Answering this request

You may delegate up to ${maxSubtasks} subtasks, each of type ${typeKeys
    .map((k) => `"${k}"`)
    .join(", ")}, or answer with final_reply.`,
  finalRoundNote: (limits) => `

# Your budget is spent

You have used this task's full budget of ${limits.maxTurns} turns. Call
final_reply now with what you have.`,
  copy: {
    taskFailed: "Sorry — something went wrong handling that request.",
    recoveredReply: "Working on your request.",
    partialNote: "Some parts of this request could not be completed."
  }
};

const instructions = buildTurnInstructions(policy, types, 8, {
  maxTurns: 20,
  maxWallMs: 60_000
});

/** A model pair whose two slots can be scripted independently. */
function pair(primary: ReturnType<typeof mockModel>, fallback = primary) {
  return {
    primary: () => primary,
    fallback: () => fallback,
    primaryId: () => TEST_MODELS.chatModelId,
    fallbackId: () => TEST_MODELS.fallbackChatModelId
  } as unknown as ModelPair;
}

function args(overrides: Partial<RunTurnArgs> = {}): RunTurnArgs {
  return {
    session: new FakeSession(),
    taskId: "t1",
    round: 0,
    text: "hello",
    mode: "open",
    budget: newTurnBudget(20),
    systemSuffix: "",
    tools: {},
    models: pair(mockModel(finalReply("done"))),
    branches: [],
    types,
    maxSubtasks: 8,
    maxOutputTokens: 4096,
    instructions,
    partialNote: policy.copy.partialNote,
    ...overrides
  };
}

describe("the round contract", () => {
  it("names every installed subtask type, and only those", () => {
    expect(instructions.open).toContain('"general"');
    // The enum is what the model may emit; a type nobody installed must not
    // appear in the prose either, or the model is invited to name it.
    expect(instructions.open).not.toContain('"arc-game"');
  });

  it("tells a budget-spent round it has no way out but answering", () => {
    expect(instructions.final).toContain("Your budget is spent");
    expect(instructions.final).toContain("final_reply");
    // Names the budget as a fact rather than as a withheld capability — a model
    // told "you cannot delegate" tries to route around it.
    expect(instructions.final).toContain("20 turns");
  });

  it("keeps the final round a superset of the open one", () => {
    // `final` is `open + note`, so the model still has the contract it needs to
    // call `final_reply` correctly. A `final` that replaced the contract would
    // leave the round with an instruction and no schema.
    expect(instructions.final.startsWith(instructions.open)).toBe(true);
  });

  it("separates the note from the contract it is appended to", () => {
    // Core adds nothing between these two independently-owned sections — see
    // `RoundPolicy`. This asserts the documented contract holds for a policy
    // that follows it, so the doc and the composition cannot drift apart.
    const seam = instructions.final.slice(instructions.open.length);
    expect(seam.startsWith("\n\n")).toBe(true);
  });
});

describe("runTurn", () => {
  it("appends the user turn once, under a deterministic id", async () => {
    const session = new FakeSession();
    await runTurn(args({ session }));
    // A Workflow step re-runs; a second append under the same id must not
    // duplicate the turn.
    await runTurn(args({ session, round: 0 }));

    const users = session.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
  });

  it("charges the budget for every step, including a failed attempt", async () => {
    const budget = newTurnBudget(20);
    // Prose with no control call is not an ending: the attempt fails and the
    // fallback gets its turn. Both slots spent real steps.
    await runTurn(
      args({
        budget,
        models: pair(mockModel({ text: "I'll get right on that" }))
      })
    );
    expect(budget.spent).toBeGreaterThanOrEqual(2);
  });

  it("falls back to the second model when the first reaches no ending", async () => {
    const outcome = await runTurn(
      args({
        models: pair(
          mockModel({ text: "narrating instead of acting" }),
          mockModel(finalReply("the actual answer"))
        )
      })
    );
    expect(outcome).toEqual({ status: "replied", reply: "the actual answer" });
  });

  it("delivers durable branch results when both models fail", async () => {
    // The work is done and the user asked for it; failing the task because the
    // *answering* model is down would throw away good results.
    const branches: CompositionBranch[] = [
      {
        subtaskId: 1,
        round: 0,
        ordinal: 0,
        type: "general",
        prompt: "research",
        dependsOn: [],
        params: {},
        status: "completed",
        resultParts: [{ kind: "text", text: "what the branch found" }],
        error: null
      }
    ];
    const outcome = await runTurn(
      args({ branches, models: pair(mockModel({ text: "no ending" })) })
    );

    expect(outcome.status).toBe("replied");
    expect(outcome).toMatchObject({ reply: "what the branch found" });
  });

  it("fails the round when both models fail with nothing durable behind them", async () => {
    const outcome = await runTurn(
      args({ models: pair(mockModel({ text: "no ending" })) })
    );
    expect(outcome.status).toBe("failed");
  });
});

describe("renderTurnMessages", () => {
  it("marks referenceable turns with the index the model selects them by", async () => {
    const session = new FakeSession();
    await runTurn(args({ session }));

    const { messages, catalog } = renderTurnMessages(
      session.messages,
      "t1",
      []
    );
    expect(catalog).toHaveLength(
      messages.filter((m) => String(m.content).startsWith("[ref ")).length
    );
    // The markers and the catalog are produced in one pass precisely so they
    // cannot disagree; a mismatch means a subtask could cite an index that
    // resolves to different text.
    expect(catalog[0]?.index).toBe(1);
  });
});

describe("joinSuccessfulBranches", () => {
  const branch = (
    status: CompositionBranch["status"],
    text: string
  ): CompositionBranch => ({
    subtaskId: 1,
    round: 0,
    ordinal: 0,
    type: "general",
    prompt: "p",
    dependsOn: [],
    params: {},
    status,
    resultParts: [{ kind: "text", text }],
    error: null
  });

  it("joins only what succeeded", () => {
    const joined = joinSuccessfulBranches(
      [branch("completed", "first"), branch("completed", "second")],
      policy.copy.partialNote
    );
    expect(joined).toBe("first\n\nsecond");
  });

  it("discloses the gap rather than presenting a partial answer as complete", () => {
    const joined = joinSuccessfulBranches(
      [branch("completed", "first"), branch("failed", "ignored")],
      policy.copy.partialNote
    );
    expect(joined).toContain("first");
    expect(joined).toContain(policy.copy.partialNote);
    expect(joined).not.toContain("ignored");
  });

  it("takes the disclosure wording from the agent, never from core", () => {
    // The note is `RoundPolicy.copy.partialNote` — a user-facing string, so it
    // is the agent's. A default here would be house prompt copy in a published
    // package, which is the line core does not cross.
    const joined = joinSuccessfulBranches(
      [branch("completed", "kept"), branch("failed", "dropped")],
      "MY OWN WORDING"
    );
    expect(joined).toContain("MY OWN WORDING");
    expect(joined).not.toContain(policy.copy.partialNote);
  });
});
