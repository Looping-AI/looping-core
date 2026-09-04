import { describe, it, expect, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import {
  deliverAbandonedTask,
  deliverTerminalTask,
  TaskAlreadyTerminalError
} from "./deliver.js";
import type { PlainTask } from "./task.js";

/**
 * {@link deliverAbandonedTask} driven directly, as a host with its own workflow
 * body uses it.
 *
 * `round/workflow.spec.ts` covers it wired into `runHandleTask`, which is how
 * every delegating agent gets it. This file covers the other consumer: an agent
 * whose turn is a single inference, which writes its own orchestration and has
 * the identical exposure — the case that made this an exported function rather
 * than a private one in `/round`.
 */

const PUSH = {
  taskId: "task-1",
  contextId: "ctx-1",
  // Unreachable on purpose: `notify` is cached away in every spec here, and one
  // that reaches the network has already failed the assertion it cares about.
  pushUrl: "https://gatekeeper.invalid/push",
  pushToken: "push-token",
  jku: "https://agent.invalid/.well-known/jwks.json"
};

function fakeStep(cached: Record<string, unknown> = {}) {
  const ran: string[] = [];
  const step = {
    async do(name: string, a: unknown, b?: unknown): Promise<unknown> {
      const body = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      ran.push(name);
      if (Object.hasOwn(cached, name)) return cached[name];
      return await body();
    }
  } as unknown as WorkflowStep;
  return { step, ran };
}

function options(over: Record<string, unknown> = {}) {
  return {
    push: PUSH,
    signingKey: "unused-in-these-specs",
    saveTask: async () => true,
    text: "I could not finish this. Nothing was changed.",
    ...over
  };
}

describe("deliverAbandonedTask", () => {
  it("delivers a failed Task carrying the host's words", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const saved: PlainTask[] = [];
    const { step } = fakeStep({ "abandoned:notify": undefined });

    await deliverAbandonedTask(step, new Error("boom"), {
      ...options({
        saveTask: async (task: PlainTask) => {
          saved.push(task);
          return true;
        }
      })
    });

    // Core ships no user-facing copy, so the words must be exactly the host's
    // and the cause must not leak into what the user reads.
    expect(JSON.stringify(saved[0])).toContain("Nothing was changed.");
    expect(JSON.stringify(saved[0])).not.toContain("boom");
  });

  /**
   * The shape a non-delegating agent uses. `sweep` is optional because an agent
   * with no managed children has nothing to reclaim, and a `sweep` step that
   * exists only to do nothing is a durable step name that can never be removed.
   */
  it("runs no sweep step when the host has no children to reclaim", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { step, ran } = fakeStep({ "abandoned:notify": undefined });

    await deliverAbandonedTask(step, new Error("boom"), options());

    expect(ran).toContain("abandoned:complete");
    expect(ran).not.toContain("abandoned:sweep");
  });

  it("sweeps between the write and the callback when one is given", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { step, ran } = fakeStep({ "abandoned:notify": undefined });

    await deliverAbandonedTask(
      step,
      new Error("boom"),
      options({ sweep: async () => {} })
    );

    // Order, not merely presence: a callback that went first would announce a
    // terminal Task whose children were still holding external state.
    expect(ran.indexOf("abandoned:complete")).toBeLessThan(
      ran.indexOf("abandoned:sweep")
    );
    expect(ran.indexOf("abandoned:sweep")).toBeLessThan(
      ran.indexOf("abandoned:notify")
    );
  });

  it("rethrows the original cause, not the delivery's own fault", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { step } = fakeStep({ "abandoned:notify": undefined });
    const cause = new Error("the provider refused every attempt");

    await expect(
      deliverAbandonedTask(
        step,
        cause,
        options({
          saveTask: async () => {
            throw new Error("durable object unreachable");
          }
        })
      )
    ).rejects.toBe(cause);
  });

  /**
   * The property that removes the need for any "did we already deliver?"
   * bookkeeping: a Task already terminal — canceled, or completed by an ordinary
   * delivery whose callback was the only thing that failed — refuses the write,
   * and the callback is suppressed rather than contradicting what is stored.
   */
  it("suppresses the callback when the guarded write refuses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { step, ran } = fakeStep();

    await deliverAbandonedTask(
      step,
      new Error("boom"),
      options({ saveTask: async () => false, sweep: async () => {} })
    );

    expect(ran).toEqual(["abandoned:complete"]);
  });
});

/**
 * The distinction between "this turn produced nothing" and "this turn produced a
 * result the gatekeeper has not heard about yet".
 *
 * Only the first is an abandoned task. Conflating them means an ordinary
 * delivery whose callback failed unwinds into a recovery that writes a generic
 * failure over a real answer — a turn that succeeded recorded as failed because
 * a webhook was flaky.
 */
describe("a delivery that failed after its Task was saved", () => {
  it("is reported as such rather than as an ordinary fault", async () => {
    const { step } = fakeStep();
    // Nothing cached, so `notify` runs its body and the unreachable host throws.
    await expect(
      deliverTerminalTask(step, {
        push: PUSH,
        signingKey: "unused-in-these-specs",
        saveTask: async () => true,
        terminal: () =>
          ({ id: PUSH.taskId, contextId: PUSH.contextId }) as never
      })
    ).rejects.toBeInstanceOf(TaskAlreadyTerminalError);
  });

  /**
   * The check lives inside the helper, not in each caller's `catch`. A recovery
   * every host had to remember to wire is what this whole change was fixing; a
   * caveat every host had to remember to check would be the same mistake again.
   */
  it("makes the recovery a no-op that rethrows the real fault", async () => {
    // Cleared, not merely created: `spyOn` on an already-spied method hands back
    // the same mock, so the specs above have already recorded calls on it.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    error.mockClear();
    const { step, ran } = fakeStep();
    const notifyFailed = new Error("gatekeeper unreachable");
    const saved: PlainTask[] = [];

    await expect(
      deliverAbandonedTask(
        step,
        new TaskAlreadyTerminalError(notifyFailed),
        options({
          saveTask: async (task: PlainTask) => {
            saved.push(task);
            return true;
          }
        })
      )
    ).rejects.toBe(notifyFailed);

    // Nothing attempted, and nothing logged: this turn was not abandoned, and
    // saying so would be worse than saying nothing.
    expect(ran).toEqual([]);
    expect(saved).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });
});
