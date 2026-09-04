/**
 * `@dynamicagents/core/alarm` — many deadlines over a Durable Object's one alarm.
 *
 * A Durable Object has exactly **one** alarm, and an object that needs to wake
 * for more than one reason cannot simply call `setAlarm` from each of them: the
 * last writer silently wins, and whatever the loser was waiting on never
 * happens. {@link WakeMap} is the fix — one storage row holding every pending
 * intent, and the only thing in a DO that calls `setAlarm`.
 *
 * **Its own subpath, deliberately.** This is useful to a plain `DurableObject`,
 * not only to a {@link DynamicAgent}, so it must be importable without pulling
 * the agent machinery into a bundle.
 *
 * **Why not `Agent.schedule()`.** The `agents` SDK has the same mechanism, but
 * sells it only as a method on `Agent`: adopting it means the object becomes an
 * `Agent`, whose constructor creates `cf_agents_state`, `cf_agents_mcp_servers`
 * and `cf_agents_queues` in that object's SQLite, builds an `MCPClientManager`,
 * and prototype-patches every public method for tracing. For an object whose
 * SQLite is something else already — a container's filesystem, say — that is a
 * large import for a small one. `agents/schedule` is not an alternative: it is a
 * prompt and a zod schema for parsing natural-language dates, not alarm
 * machinery.
 *
 * This owns *when* an object wakes. What it owes on waking is the object's own:
 * `alarm()` reads {@link WakeMap.due} and dispatches.
 */

/** One scheduled wake-up. */
export interface WakeIntent {
  /** Why we are waking. Namespace it, e.g. `sync-retry:container-shell`. */
  key: string;
  /** Epoch ms at which this intent becomes due. */
  notBefore: number;
  /** Retry counter, for the intents that carry one. */
  attempt?: number;
}

/** The single storage row holding every intent. Small, and written atomically. */
export const WAKE_KEY = "wake";

/** How far out {@link WakeMap.repair} re-arms when the handler itself failed. */
export const WAKE_REPAIR_MS = 60_000;

export class WakeMap {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  /**
   * Every pending intent, as a **null-prototype** dictionary rebuilt from own
   * entries only.
   *
   * {@link WakeIntent.key} is a caller-supplied string, so an ordinary object
   * literal would let three of them misbehave: `get("toString")` would return an
   * inherited function rather than `undefined`, `clear("constructor")` would
   * treat a key it never held as present, and `set` on `"__proto__"` would hit
   * `Object.prototype`'s setter and change the prototype instead of storing the
   * intent. With no prototype there is nothing to inherit and nothing to poison,
   * and every string round-trips as an ordinary key.
   */
  async all(): Promise<Record<string, WakeIntent>> {
    const stored =
      await this.#storage.get<Record<string, WakeIntent>>(WAKE_KEY);
    const intents = Object.create(null) as Record<string, WakeIntent>;
    // `Object.entries` is own-enumerable-only, so nothing from a prototype can
    // enter here even if the stored value arrived with one.
    if (stored) {
      for (const [key, intent] of Object.entries(stored)) intents[key] = intent;
    }
    return intents;
  }

  async get(key: string): Promise<WakeIntent | undefined> {
    return (await this.all())[key];
  }

  async set(intent: WakeIntent): Promise<void> {
    const all = await this.all();
    all[intent.key] = intent;
    await this.#storage.put(WAKE_KEY, all);
    await this.rearm();
  }

  async clear(key: string): Promise<void> {
    const all = await this.all();
    // `hasOwn`, not `in`: the dictionary has no prototype today, and this stays
    // correct if that ever changes.
    if (!Object.hasOwn(all, key)) return;
    delete all[key];
    await this.#storage.put(WAKE_KEY, all);
    await this.rearm();
  }

  /** Every intent whose time has come, earliest first. */
  async due(now: number): Promise<WakeIntent[]> {
    return Object.values(await this.all())
      .filter((intent) => intent.notBefore <= now)
      .sort((a, b) => a.notBefore - b.notBefore);
  }

  /**
   * Point the alarm at the earliest deadline.
   *
   * Only ever moved **earlier**, never later: an alarm that fires too soon finds
   * nothing due, re-arms, and costs one wake-up, whereas an alarm pushed later
   * by a coincidental write silently delays whatever was already waiting. When
   * no intents remain the alarm is deleted outright, so an idle object does not
   * wake on a schedule it has no use for.
   */
  async rearm(): Promise<void> {
    const deadlines = Object.values(await this.all()).map((i) => i.notBefore);
    const existing = await this.#storage.getAlarm();

    if (deadlines.length === 0) {
      if (existing !== null) await this.#storage.deleteAlarm();
      return;
    }

    const earliest = Math.min(...deadlines);
    if (existing === null || existing > earliest) {
      await this.#storage.setAlarm(earliest);
    }
  }

  /**
   * Re-arm shortly, for when the handler failed before it could work out what
   * it owed. Distinct from {@link rearm} because that one trusts the map, and
   * the map is what we just failed to read.
   */
  async repair(now: number): Promise<void> {
    const existing = await this.#storage.getAlarm();
    if (existing === null) await this.#storage.setAlarm(now + WAKE_REPAIR_MS);
  }
}
