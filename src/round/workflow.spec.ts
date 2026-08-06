import { describe, it, expect } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import type { GatewayIdentity } from "@loopingai/a2a-protocol";
import { resolveConfig } from "../config.js";
import { TEST_MODELS } from "../testing/fixtures.js";
import { runHandleTask, type HandleTaskDeps } from "./workflow.js";
import type { RoundPolicy } from "./policy.js";

/**
 * The durable orchestration: cancellation ordering, replay determinism, and the
 * save-before-notify rule.
 *
 * ## Why a fake `step`
 *
 * Every fact here is about *which steps run, in what order, on what verdict* —
 * and none of it is observable from the outside. A canceled task that still
 * posts a `completed` callback looks identical to a healthy one until the
 * gateway shows a reply for work the user abandoned.
 *
 * The `cached` option is what a Workflow replay actually does: serve an
 * already-durable step's recorded result without re-running its body. That is
 * how these drive a full task with no model behind `turn:0` — and it is also the
 * property being tested in the determinism specs, since a step whose input
 * depends on unrecorded state reconstructs differently on replay.
 *
 * This is the file whose absence let the whole loop move into a published
 * package uncovered; `turn.spec.ts` explains how that happened.
 */

const IDENTITY: GatewayIdentity = {
  key: "remote:1:test",
  name: "Test",
  kind: "remote",
  workspaceId: 1
};

const policy: RoundPolicy = {
  roundContract: () => "\n\ncontract",
  finalRoundNote: () => "\n\nnote",
  copy: {
    taskFailed: "TASK FAILED COPY",
    recoveredReply: "recovered",
    partialNote: "partial"
  }
};

interface FakeStepOptions {
  /** Step results served without running the body — a Workflow replay. */
  cached?: Record<string, unknown>;
  /**
   * Extra attempts a throwing body gets, like the platform's own step retries.
   * Zero (the default) keeps every other spec's single-shot behaviour.
   */
  retries?: number;
}

function fakeStep(options: FakeStepOptions = {}) {
  const ran: string[] = [];
  const step = {
    async do(name: string, a: unknown, b?: unknown): Promise<unknown> {
      const body = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      ran.push(name);
      if (Object.hasOwn(options.cached ?? {}, name))
        return options.cached![name];
      let last: unknown;
      for (let attempt = 0; attempt <= (options.retries ?? 0); attempt++) {
        try {
          return await body();
        } catch (err) {
          last = err;
        }
      }
      throw last;
    }
  } as unknown as WorkflowStep;
  return { step, ran };
}

interface FakeAgentOptions {
  markWorking?: "ok" | "canceled";
  /** Whether the guarded terminal write applies. `false` ⇒ a cancel won. */
  saveTask?: boolean;
}

function fakeAgent(options: FakeAgentOptions = {}) {
  const calls: string[] = [];
  const stub = {
    async markWorking() {
      calls.push("markWorking");
      return options.markWorking ?? "ok";
    },
    async runTaskTurn() {
      calls.push("runTaskTurn");
      return { status: "replied", reply: "the answer", turns: 1 };
    },
    async saveTask() {
      calls.push("saveTask");
      return options.saveTask ?? true;
    },
    async sweepTaskChildren() {
      calls.push("sweepTaskChildren");
    },
    async cancelPendingSubtasks() {
      calls.push("cancelPendingSubtasks");
      return 0;
    }
  };
  return { stub, calls };
}

function params() {
  return {
    taskId: "task-1",
    text: "do the thing",
    identity: IDENTITY,
    contextId: "ctx-1",
    // Unreachable on purpose: a spec that posts here has already failed the
    // assertion it cares about.
    pushUrl: "https://gateway.invalid/push",
    pushToken: "push-token",
    jku: "https://agent.invalid/.well-known/jwks.json"
  };
}

function deps(stub: unknown): HandleTaskDeps {
  return {
    resolveAgent: () => stub as never,
    config: resolveConfig({ model: TEST_MODELS }),
    policy,
    signingKey: "unused-in-these-specs"
  };
}

describe("a task canceled before the workflow starts", () => {
  it("never runs a turn and never calls back", async () => {
    const { stub, calls } = fakeAgent({ markWorking: "canceled" });
    const { step, ran } = fakeStep();

    await runHandleTask(params(), step, deps(stub));

    // `markWorking` reports the cancellation itself, so the pipeline stops on
    // its verdict rather than on a separate probe. Discarding that verdict
    // bills a model call and posts a callback for a task the caller abandoned —
    // the exact bug that made the second copy of this loop diverge.
    expect(ran).toEqual(["working"]);
    expect(calls).toEqual(["markWorking"]);
    expect(calls).not.toContain("runTaskTurn");
  });
});

describe("a task canceled while the model is working", () => {
  it("keys the callback on the guarded write, not on a probe", async () => {
    // `saveTask` refuses: a `tasks/cancel` landed after the turn produced a
    // reply. The terminal write is the only authority — it does its read and
    // its write in one synchronous pass inside the DO, so nothing can slip
    // between them the way a `getTask` probe allows.
    const { stub } = fakeAgent({ saveTask: false });
    const { step, ran } = fakeStep({
      cached: { "turn:0": { status: "replied", reply: "the answer", turns: 1 } }
    });

    await runHandleTask(params(), step, deps(stub));

    expect(ran).toContain("complete");
    expect(ran).not.toContain("notify");
    // …and the sweep is skipped too: it belongs to a task that terminated, and
    // this one did not.
    expect(ran).not.toContain("sweep");
  });
});

describe("the ordinary path", () => {
  it("saves the terminal task before it notifies, and sweeps between", async () => {
    const { stub, calls } = fakeAgent({ saveTask: true });
    const { step, ran } = fakeStep({
      cached: {
        "turn:0": { status: "replied", reply: "the answer", turns: 1 },
        notify: undefined
      }
    });

    await runHandleTask(params(), step, deps(stub));

    // Order is the assertion, not merely presence. A notify that ran before the
    // guarded save would post a reply the DO might then refuse to record.
    expect(ran.indexOf("complete")).toBeLessThan(ran.indexOf("sweep"));
    expect(ran.indexOf("sweep")).toBeLessThan(ran.indexOf("notify"));
    expect(calls).toContain("saveTask");
  });

  it("still notifies when the sweep fails after its retries are exhausted", async () => {
    // The terminal Task is already durably saved by the time sweep runs, so a
    // stuck or unreachable cleanup RPC must not strand the gateway without its
    // result — logged and skipped, not fatal to `notify`.
    const { stub } = fakeAgent();
    const spy = {
      ...stub,
      async sweepTaskChildren() {
        throw new Error("facet unreachable");
      }
    };
    const { step, ran } = fakeStep({
      cached: {
        "turn:0": { status: "replied", reply: "the answer", turns: 1 },
        notify: undefined
      }
    });

    await runHandleTask(params(), step, deps(spy));

    expect(ran).toContain("sweep");
    expect(ran).toContain("notify");
  });

  it("reads the clock inside a step, so a replay sees the original instant", async () => {
    // `started` exists to be cached. A workflow that retried overnight and
    // re-read `Date.now()` would restart its own deadline and never observe the
    // budget it had long since blown.
    const { stub } = fakeAgent();
    const { step, ran } = fakeStep({
      cached: {
        "turn:0": { status: "replied", reply: "x", turns: 1 },
        notify: undefined
      }
    });

    await runHandleTask(params(), step, deps(stub));
    expect(ran).toContain("started");
    expect(ran.indexOf("started")).toBeLessThan(ran.indexOf("turn:0"));
  });
});

describe("a Durable Object replaced under a running workflow", () => {
  /**
   * The incident these two specs exist for.
   *
   * A deploy landed three minutes before a turn. The agent DO was collected 43
   * seconds into `executeSubtaskChunk`, and the five retries that followed each
   * failed in under 10ms across 160 seconds of backoff — then `fail:<id>`, the
   * handler that exists to salvage exactly this, failed six more times the same
   * way. The Subtask never reached a terminal row, `deliver` was never reached,
   * and the gateway received no callback at all.
   *
   * Every one of those failures was a call on a stub the runtime had already
   * severed. A broken stub does not reconnect; it rejects with the reason it
   * broke, forever. So a run that resolves once and closes over the result has
   * retries that cannot retry — they re-enter the body and re-call a corpse.
   *
   * Both specs below fail against a hoisted stub and pass against a resolver.
   */

  /** A stub whose every method rejects the way a severed one does. */
  function severedStub() {
    const reject = async () => {
      throw new Error("Durable Object reset because its code was updated.");
    };
    return {
      markWorking: reject,
      runTaskTurn: reject,
      saveTask: reject,
      sweepTaskChildren: reject,
      cancelPendingSubtasks: reject,
      skipBlockedSubtasks: reject,
      executeSubtaskChunk: reject,
      failSubtask: reject
    };
  }

  it("recovers on retry, because the retry resolves a live stub", async () => {
    // The first stub handed out is already dead — the eviction happened between
    // the namespace lookup and the call. Every later lookup gets a healthy one,
    // which is precisely what the platform does once the new code is live.
    const { stub, calls } = fakeAgent();
    let resolved = 0;
    const resolveAgent = () => {
      resolved += 1;
      return (resolved === 1 ? severedStub() : stub) as never;
    };

    const { step, ran } = fakeStep({
      retries: 5,
      cached: {
        "turn:0": { status: "replied", reply: "the answer", turns: 1 },
        notify: undefined
      }
    });

    await runHandleTask(params(), step, {
      ...deps(stub),
      resolveAgent
    });

    // The run survived the eviction and delivered. Under a hoisted stub the
    // severed one is the *only* one there is, so `working` exhausts its retries
    // and the task dies before it ever reaches a model.
    expect(calls).toContain("markWorking");
    expect(ran).toContain("notify");
  });

  it("resolves per step body, not once per run", async () => {
    // The property itself, stated directly: a hoisted stub resolves exactly
    // once no matter how many steps run, so the count is the whole difference
    // between a retry that can recover and one that cannot.
    const { stub } = fakeAgent();
    let resolved = 0;
    const resolveAgent = () => {
      resolved += 1;
      return stub as never;
    };

    const { step } = fakeStep({
      cached: {
        "turn:0": { status: "replied", reply: "the answer", turns: 1 },
        notify: undefined
      }
    });

    await runHandleTask(params(), step, { ...deps(stub), resolveAgent });

    // `working`, `complete` and `sweep` each reach the DO — `turn:0` and
    // `notify` are served from cache here, and `started`/`deadline:0` never
    // touch it.
    expect(resolved).toBe(3);
  });
});

describe("a failed turn", () => {
  it("delivers the agent's own failure copy, never core's", async () => {
    // `taskFailed` is `RoundPolicy` copy — a user-facing string, so it is the
    // agent's. Core shipping a default here would be house prompt copy in a
    // published package.
    const saved: unknown[] = [];
    const { stub } = fakeAgent();
    const spy = {
      ...stub,
      async saveTask(task: unknown) {
        saved.push(task);
        return true;
      }
    };
    const { step } = fakeStep({
      cached: {
        "turn:0": { status: "failed", error: "model exploded", turns: 1 },
        notify: undefined
      }
    });

    await runHandleTask(params(), step, deps(spy));

    const task = saved[0] as { status: { message?: { parts?: unknown[] } } };
    expect(JSON.stringify(task)).toContain(policy.copy.taskFailed);
    // The diagnostic is logged, not shown: the user reads the policy string.
    expect(JSON.stringify(task)).not.toContain("model exploded");
  });
});
