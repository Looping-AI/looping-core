import { describe, it, expect } from "vitest";
import { WakeMap, WAKE_KEY } from "../alarm/index.js";
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
  /** Comfortably longer than any age used below, so staleness never fires. */
  const LIVE = 60 * 60_000;

  it("refuses a second run while one is in flight", () => {
    const { job } = lifecycle();
    expect(job.claim(running(Date.now()), LIVE).ok).toBe(false);
  });

  it("admits the alarm presenting its own placeholder stamp", () => {
    const { job } = lifecycle();
    const at = Date.now();
    expect(job.claim(running(at), LIVE, at).ok).toBe(true);
  });

  it("refuses a take-over with any other stamp", () => {
    // This is the displacement bug in a new hat: an exemption keyed on anything
    // looser than the exact stamp becomes "take over any running job".
    const { job } = lifecycle();
    const at = Date.now();
    expect(job.claim(running(at), LIVE, at - 1).ok).toBe(false);
    expect(job.claim(running(at), LIVE, undefined).ok).toBe(false);
  });

  it("admits a run when the record is terminal", () => {
    const { job } = lifecycle();
    expect(job.claim({ state: "idle" }, LIVE).ok).toBe(true);
    expect(
      job.claim(
        { state: "done", command: "npm ci", exitCode: 0, finishedAt: 1, ms: 1 },
        LIVE
      ).ok
    ).toBe(true);
  });

  it("applies the staleness bound itself rather than trusting the caller", () => {
    // The previous signature took an "already-repaired" state and said so only
    // in prose. Nothing enforced it, so a caller passing a raw read got a
    // `running` record that could never be claimed and a job wedged forever.
    const { job } = lifecycle();
    // In flight and inside its budget: a second run must wait.
    expect(job.claim(running(Date.now()), LIVE).ok).toBe(false);
    // Written by an isolate that is long gone: claimable, or it blocks forever.
    expect(job.claim(running(0), LIVE).ok).toBe(true);
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

  it("never hands ownership back once superseded", async () => {
    // The latch must be checked *before* the read. A context that returns to the
    // original stamp does not restore ownership — a drain regaining write
    // access here is exactly the corruption the marker exists to prevent.
    const { job } = lifecycle();
    await job.putContext({ startedAt: 500 });
    const gen = job.generation(500);
    expect(await gen.stillMine()).toBe(true);

    await job.putContext({ startedAt: 900 });
    expect(await gen.stillMine()).toBe(false);

    await job.putContext({ startedAt: 500 });
    expect(await gen.stillMine()).toBe(false);
    expect(gen.superseded()).toBe(true);
  });

  it("treats a missing context as superseded rather than owned", async () => {
    const { job } = lifecycle();
    const gen = job.generation(500);
    expect(await gen.stillMine()).toBe(false);
  });
});

describe("reserved ids", () => {
  /**
   * `"wake"` is `WakeMap`'s single storage row. A job with that id overwrites
   * the whole intent map on its first state write, and the `wake.set()` right
   * after then reads job fields as intents — so every pending wake-up on the
   * object, not just this job's, silently stops happening.
   */
  it("refuses WakeMap's own storage key", () => {
    const storage = fakeStorage();
    expect(
      () =>
        new JobLifecycle({ id: "wake", storage, wake: new WakeMap(storage) })
    ).toThrow(/reserved/);
  });

  it("refuses an empty id", () => {
    const storage = fakeStorage();
    expect(
      () => new JobLifecycle({ id: "", storage, wake: new WakeMap(storage) })
    ).toThrow(/non-empty/);
  });

  /**
   * The guard hardcodes `"wake"` so this module reaches `../alarm` for types
   * only — a value import would pull the alarm module into every bundle that
   * imports `/job`. This assertion is what keeps the duplicate honest; specs
   * never ship, so it costs nothing at runtime.
   */
  it("keeps the hardcoded reserved key in step with WAKE_KEY", () => {
    expect(WAKE_KEY).toBe("wake");
  });
});

describe("arm rollback", () => {
  /**
   * The placeholder and the alarm that owns it are two writes. A failure
   * between them leaves a `running` record no run intent points at, which every
   * later `arm()` then declines to replace *because* it is running.
   */
  it("restores the prior state when scheduling fails", async () => {
    const storage = fakeStorage();
    const wake = new WakeMap(storage);
    wake.set = async () => {
      throw new Error("alarm unavailable");
    };
    const job = new JobLifecycle<Install>({ id: "install", storage, wake });

    const before: JobState<Install> = {
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    };
    await job.write(before);

    await expect(job.arm({ command: "npm ci" })).rejects.toThrow(
      "alarm unavailable"
    );

    // Left exactly as re-armable as it was found, rather than wedged at
    // `running` until a full timeout elapses.
    expect(await job.read()).toEqual(before);
    expect(await job.armedAt()).toBeUndefined();
  });

  it("keeps the cooldown floor even when scheduling failed", async () => {
    // A floor that applied only to *successful* arming would let a persistently
    // failing schedule re-arm on every call into the object.
    const storage = fakeStorage();
    const wake = new WakeMap(storage);
    wake.set = async () => {
      throw new Error("alarm unavailable");
    };
    const job = new JobLifecycle<Install>({ id: "install", storage, wake });
    await job.write({
      state: "failed",
      command: "npm ci",
      finishedAt: 1,
      error: "x"
    });

    await expect(job.arm({ command: "npm ci" })).rejects.toThrow();
    expect(await storage.get("install:last-armed")).toBeTypeOf("number");
  });
});

describe("the watchdog", () => {
  it("arms the namespaced intent at the watch deadline", async () => {
    const { job, wake } = lifecycle();
    const now = 1_000_000;
    await job.armWatch(now);

    const intent = await wake.get("install-watch");
    // Default watchMs is 60s; the deadline is what a dead drain is recovered by.
    expect(intent?.notBefore).toBe(now + 60_000);
  });

  it("honours a configured watchMs", async () => {
    const storage = fakeStorage();
    const wake = new WakeMap(storage);
    const job = new JobLifecycle<Install>({
      id: "install",
      storage,
      wake,
      watchMs: 5_000
    });
    await job.armWatch(1_000_000);
    expect((await wake.get("install-watch"))?.notBefore).toBe(1_005_000);
  });

  it("disarms on request", async () => {
    const { job, wake } = lifecycle();
    await job.armWatch(1_000_000);
    expect(await wake.get("install-watch")).toBeDefined();
    await job.clearWatch();
    expect(await wake.get("install-watch")).toBeUndefined();
  });

  it("swallows a failure to disarm", async () => {
    // Called from a `finally`, so a throw here would mask the drain's own
    // outcome — which is the thing the caller actually needs to report.
    const { job, wake } = lifecycle();
    wake.clear = async () => {
      throw new Error("storage gone");
    };
    await expect(job.clearWatch()).resolves.toBeUndefined();
  });
});
