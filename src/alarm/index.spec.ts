import { describe, it, expect } from "vitest";
import { WakeMap, WAKE_REPAIR_MS, type WakeIntent } from "./index.js";

/**
 * The whole point of this class is that it is the *only* caller of `setAlarm`,
 * so what these specs pin is the arming policy rather than the map: an alarm
 * moved later by a coincidental write is how a pending intent silently stops
 * happening, and that is not observable from the map's contents.
 *
 * Driven through a fake rather than a real Durable Object because every rule
 * below is about the four storage calls in a particular order, which a fake
 * makes assertable and a real DO only makes reachable.
 */
function fakeStorage() {
  const rows = new Map<string, unknown>();
  let alarm: number | null = null;
  const calls: string[] = [];

  const storage = {
    get: async <T>(key: string): Promise<T | undefined> =>
      rows.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      rows.set(key, structuredClone(value));
    },
    getAlarm: async (): Promise<number | null> => alarm,
    setAlarm: async (when: number): Promise<void> => {
      calls.push(`set:${when}`);
      alarm = when;
    },
    deleteAlarm: async (): Promise<void> => {
      calls.push("delete");
      alarm = null;
    }
  };

  return {
    wake: new WakeMap(storage as unknown as DurableObjectStorage),
    alarmAt: () => alarm,
    calls
  };
}

const intent = (key: string, notBefore: number): WakeIntent => ({
  key,
  notBefore
});

describe("WakeMap", () => {
  it("round-trips an intent and arms the alarm for it", async () => {
    const { wake, alarmAt } = fakeStorage();
    await wake.set(intent("install-watch", 1_000));

    expect(await wake.get("install-watch")).toEqual({
      key: "install-watch",
      notBefore: 1_000
    });
    expect(alarmAt()).toBe(1_000);
  });

  it("keeps intents independent, which is the reason it exists", async () => {
    const { wake } = fakeStorage();
    await wake.set(intent("sync-retry:container-shell", 5_000));
    await wake.set(intent("container-idle", 9_000));

    expect(Object.keys(await wake.all()).sort()).toEqual([
      "container-idle",
      "sync-retry:container-shell"
    ]);
  });

  it("replaces an intent written twice under one key", async () => {
    const { wake } = fakeStorage();
    await wake.set({ key: "sync-retry:a", notBefore: 5_000, attempt: 1 });
    await wake.set({ key: "sync-retry:a", notBefore: 8_000, attempt: 2 });

    expect(Object.keys(await wake.all())).toEqual(["sync-retry:a"]);
    expect(await wake.get("sync-retry:a")).toEqual({
      key: "sync-retry:a",
      notBefore: 8_000,
      attempt: 2
    });
  });

  it("returns only what is due, earliest first", async () => {
    const { wake } = fakeStorage();
    await wake.set(intent("late", 9_000));
    await wake.set(intent("early", 1_000));
    await wake.set(intent("middle", 5_000));

    expect((await wake.due(5_000)).map((i) => i.key)).toEqual([
      "early",
      "middle"
    ]);
    expect(await wake.due(0)).toEqual([]);
  });

  /**
   * The rule the whole class exists for. An alarm that fires early finds nothing
   * due and costs one wake-up; an alarm pushed later drops whatever was already
   * waiting on the floor — in production that was a stranded container sync.
   */
  it("moves the alarm earlier but never later", async () => {
    const { wake, alarmAt } = fakeStorage();
    await wake.set(intent("first", 5_000));
    expect(alarmAt()).toBe(5_000);

    await wake.set(intent("sooner", 2_000));
    expect(alarmAt()).toBe(2_000);

    await wake.set(intent("later", 9_000));
    expect(alarmAt()).toBe(2_000);
  });

  it("deletes the alarm once the last intent clears", async () => {
    const { wake, alarmAt, calls } = fakeStorage();
    await wake.set(intent("only", 1_000));
    await wake.clear("only");

    expect(await wake.all()).toEqual({});
    expect(alarmAt()).toBeNull();
    expect(calls).toContain("delete");
  });

  it("leaves the alarm alone when clearing a key it never held", async () => {
    const { wake, alarmAt, calls } = fakeStorage();
    await wake.set(intent("kept", 4_000));
    const before = calls.length;

    await wake.clear("never-set");

    expect(alarmAt()).toBe(4_000);
    // No re-arm at all: the map did not change, so nothing should have touched
    // the alarm.
    expect(calls.length).toBe(before);
  });

  /**
   * `key` is a caller-supplied string, so the three names that mean something to
   * `Object.prototype` have to behave like any other key.
   */
  describe("keys that collide with Object.prototype", () => {
    it("does not report an inherited member as a stored intent", async () => {
      const { wake } = fakeStorage();

      expect(await wake.get("toString")).toBeUndefined();
      expect(await wake.get("constructor")).toBeUndefined();
      expect(await wake.get("__proto__")).toBeUndefined();
      expect(await wake.due(Date.now())).toEqual([]);
    });

    it("stores and returns them like any other key", async () => {
      const { wake, alarmAt } = fakeStorage();
      await wake.set(intent("__proto__", 1_000));
      await wake.set(intent("toString", 2_000));

      expect(await wake.get("__proto__")).toEqual({
        key: "__proto__",
        notBefore: 1_000
      });
      expect(await wake.get("toString")).toEqual({
        key: "toString",
        notBefore: 2_000
      });
      // Proof it was stored rather than swallowed by the prototype setter.
      expect(alarmAt()).toBe(1_000);
      expect((await wake.due(2_000)).map((i) => i.key)).toEqual([
        "__proto__",
        "toString"
      ]);
    });

    it("treats clearing an unheld prototype name as a no-op", async () => {
      const { wake, alarmAt, calls } = fakeStorage();
      await wake.set(intent("kept", 4_000));
      const before = calls.length;

      await wake.clear("constructor");

      expect(await wake.get("kept")).toBeDefined();
      expect(alarmAt()).toBe(4_000);
      expect(calls.length).toBe(before);
    });
  });

  describe("repair", () => {
    it("arms a short retry when the handler failed with no alarm left", async () => {
      const { wake, alarmAt } = fakeStorage();
      await wake.repair(10_000);
      expect(alarmAt()).toBe(10_000 + WAKE_REPAIR_MS);
    });

    it("does not touch an alarm that is already set", async () => {
      const { wake, alarmAt } = fakeStorage();
      await wake.set(intent("pending", 3_000));
      await wake.repair(10_000);
      expect(alarmAt()).toBe(3_000);
    });
  });
});
