import { describe, it, expect } from "vitest";
import { WakeMap } from "../alarm/index.js";
import { JobLifecycle } from "./lifecycle.js";
import type { JobState } from "./state.js";

/**
 * What these specs pin is the *choreography*, not the job. Every rule here
 * exists because its absence was a production failure in the predecessor, so
 * each one is asserted negatively — that the wrong thing is refused — rather
 * than merely that the right thing works.
 *
 * Driven through a fake storage for the same reason `alarm/index.spec.ts` is:
 * the rules are about which keys are written in which order, which a fake makes
 * assertable and a real Durable Object only makes reachable.
 */
function fakeStorage(): DurableObjectStorage {
  const rows = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    get: async <T>(key: string): Promise<T | undefined> =>
      rows.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      rows.set(key, structuredClone(value));
    },
    delete: async (key: string): Promise<boolean> => rows.delete(key),
    getAlarm: async (): Promise<number | null> => alarm,
    setAlarm: async (when: number): Promise<void> => {
      alarm = when;
    },
    deleteAlarm: async (): Promise<void> => {
      alarm = null;
    }
  } as unknown as DurableObjectStorage;
}

type Install = { command: string };

function lifecycle(id = "install") {
  const storage = fakeStorage();
  const wake = new WakeMap(storage);
  return {
    storage,
    wake,
    job: new JobLifecycle<Install>({ id, storage, wake })
  };
}

describe("key derivation", () => {
  /**
   * The zero-migration guarantee. These six strings are what the predecessor
   * wrote by hand, and a deployed object's storage still holds them — so a
   * change here is not a rename, it is every live workspace losing its install
   * record and its pending intents at once.
   */
  it("reproduces the hand-written keys for id 'install'", () => {
    const { job } = lifecycle();
    expect(job.stateKey).toBe("install");
    expect(job.armedKey).toBe("install:armed");
    expect(job.lastArmedKey).toBe("install:last-armed");
    expect(job.contextKey).toBe("install:context");
    expect(job.runIntent).toBe("install-run");
    expect(job.watchIntent).toBe("install-watch");
  });

  it("namespaces a second job on the same object", () => {
    const { job } = lifecycle("claude-run");
    expect(job.stateKey).toBe("claude-run");
    expect(job.runIntent).toBe("claude-run-run");
  });
});

describe("arm", () => {
  it("writes running before anything runs, and arms the run intent", async () => {
    const { job, wake } = lifecycle();
    await job.write({
      state: "done",
      command: "npm ci",
      exitCode: 0,
      finishedAt: 1,
      ms: 1
    });

    const armedAt = await job.arm({ command: "npm ci" });
    expect(armedAt).toBeTypeOf("number");

    const state = await job.read();
    // `running`, not `done` — a `done` record in this window lets a gated caller
    // through against a workspace that is not ready.
    expect(state.state).toBe("running");
    expect(await job.armedAt()).toBe(armedAt);
    expect((await wake.get(job.runIntent))?.notBefore).toBe(armedAt);
  });

  it("is self-limiting: a second call sees running and declines", async () => {
    const { job } = lifecycle();
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    });
    expect(await job.arm({ command: "npm ci" })).toBeTypeOf("number");
    expect(await job.arm({ command: "npm ci" })).toBeUndefined();
  });

  it("re-arms from failed, not only from done", async () => {
    // Arming used to require `done`, so one bad run left a record that declined
    // to re-arm forever — one failure poisoning every task after it.
    const { job } = lifecycle();
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    });
    expect(await job.arm({ command: "npm ci" })).toBeTypeOf("number");
  });

  it("refuses to re-arm from skipped or idle", async () => {
    const { job } = lifecycle();
    expect(await job.arm({ command: "npm ci" })).toBeUndefined(); // idle
    await job.write({ state: "skipped", reason: "nothing to install" });
    expect(await job.arm({ command: "npm ci" })).toBeUndefined();
  });

  it("honours the cooldown floor between attempts", async () => {
    const { job, storage } = lifecycle();
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    });
    expect(await job.arm({ command: "npm ci" })).toBeTypeOf("number");

    // Back to a re-armable state, but still inside the cooldown window.
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 2,
      error: "y"
    });
    expect(await job.arm({ command: "npm ci" })).toBeUndefined();

    // Age the cooldown marker past the floor.
    await storage.put("install:last-armed", Date.now() - 10 * 60_000);
    expect(await job.arm({ command: "npm ci" })).toBeTypeOf("number");
  });
});

describe("claim", () => {
  const running = (startedAt: number): JobState<Install> => ({
    state: "running",
    command: "npm ci",
    startedAt
  });

  it("refuses a second run while one is in flight", () => {
    const { job } = lifecycle();
    const verdict = job.claim(running(1000));
    expect(verdict.ok).toBe(false);
  });

  it("admits the alarm presenting its own placeholder stamp", () => {
    const { job } = lifecycle();
    expect(job.claim(running(1000), 1000).ok).toBe(true);
  });

  it("refuses a take-over with any other stamp", () => {
    // This is the displacement bug in a new hat: an exemption keyed on anything
    // looser than the exact stamp becomes "take over any running job".
    const { job } = lifecycle();
    expect(job.claim(running(1000), 999).ok).toBe(false);
    expect(job.claim(running(1000), undefined).ok).toBe(false);
  });

  it("admits a run when the record is terminal", () => {
    const { job } = lifecycle();
    expect(job.claim({ state: "idle" }).ok).toBe(true);
    expect(
      job.claim({
        state: "done",
        command: "npm ci",
        exitCode: 0,
        finishedAt: 1,
        ms: 1
      }).ok
    ).toBe(true);
  });
});

describe("staleness", () => {
  it("outlasts a job that is merely slow", () => {
    const { job } = lifecycle();
    const state = {
      state: "running" as const,
      command: "npm ci",
      startedAt: 0
    };
    // timeout 60s + default 5min stale bound: still live at 5 minutes.
    expect(job.isStale(state, 60_000, 5 * 60_000)).toBe(false);
    expect(job.isStale(state, 60_000, 6 * 60_000 + 1)).toBe(true);
  });
});

describe("generation", () => {
  it("still mine while the context stamp matches", async () => {
    const { job } = lifecycle();
    await job.putContext({ startedAt: 500 });
    const gen = job.generation(500);
    expect(await gen.stillMine()).toBe(true);
    expect(gen.superseded()).toBe(false);
  });

  it("latches superseded once the stamp moves on", async () => {
    // A drain can outlive the job it watched: `ctx.waitUntil` keeps running
    // after the RPC returns, and a late verdict written over a live record is
    // silent corruption.
    const { job } = lifecycle();
    await job.putContext({ startedAt: 500 });
    const gen = job.generation(500);
    await job.putContext({ startedAt: 900 });

    expect(await gen.stillMine()).toBe(false);
    // Latched, so the drain can ask afterwards whether it may touch the
    // watchdog — which belongs to whichever run owns the record now.
    expect(gen.superseded()).toBe(true);
  });

  it("treats a missing context as superseded rather than owned", async () => {
    const { job } = lifecycle();
    const gen = job.generation(500);
    expect(await gen.stillMine()).toBe(false);
  });
});
