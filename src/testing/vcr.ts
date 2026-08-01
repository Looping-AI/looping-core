import { MockAgent, SnapshotAgent, type Dispatcher } from "undici";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VCR_CONTROL_ORIGIN, CASSETTE_NAME_RE } from "./vcr-shared";

/**
 * undici stamps every cassette entry with two volatile fields we never want
 * committed: `callCount` — which its recorder *mutates on every replay* (to walk
 * sequential responses) — and `timestamp`, the record-time clock. Neither is
 * needed for playback (`callCount` defaults to 0 on load; `timestamp` is unused),
 * so we delete them from a freshly recorded cassette. Removing them is also what
 * stops a plain `npm test` from dirtying cassettes: with no persisted `callCount`
 * there is nothing for a replay to bump — and {@link VcrAgent.close} no longer
 * writes in playback anyway.
 */
function stripVolatileFields(file: string): void {
  const entries = JSON.parse(readFileSync(file, "utf8")) as {
    snapshot: { callCount?: number; timestamp?: string };
  }[];
  for (const { snapshot } of entries) {
    delete snapshot.callCount;
    delete snapshot.timestamp;
  }
  writeFileSync(file, JSON.stringify(entries, null, 2));
}

function originHost(origin: string | URL | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(String(origin)).host;
  } catch {
    return null;
  }
}

export interface CreateVcrAgentOptions {
  /** Absolute path of the cassettes directory (test/snapshots/). */
  snapshotsDir: string;
  /**
   * true → every activated cassette records real traffic, unconditionally
   * overwriting whatever was there (undici's `"record"` mode never loads or
   * matches existing entries, unlike `"update"` — see {@link VcrAgent.agentFor}).
   * false → replay.
   */
  record: boolean;
  /** Hosts served by ordinary MockAgent interceptors, never VCR'd (the gateway JWKS). */
  passthroughHosts: string[];
  /** Request headers never written to a cassette (secrets: API keys, auth). */
  excludeHeaders?: string[];
  /** Headers stored but excluded from request matching (e.g. session cookies). */
  ignoreHeaders?: string[];
}

const CONTROL_HOST = new URL(VCR_CONTROL_ORIGIN).host;

/**
 * The single agent Miniflare accepts as `fetchMock` (it allows only one), fanning
 * outbound worker requests out by role:
 *
 *  - **Control channel** ({@link VCR_CONTROL_ORIGIN}) → ordinary MockAgent
 *    interceptors whose reply callbacks flip the *active cassette*. This is how a
 *    spec running in workerd (no filesystem) tells this Node-side agent which
 *    test is running — see `setupRecording` (vcr-spec.ts).
 *  - **Passthrough hosts** (the gateway JWKS) → ordinary MockAgent interceptors,
 *    unchanged from before VCR existed.
 *  - **Everything else, while a cassette is active** → that cassette's undici
 *    {@link SnapshotAgent} record/replay. In playback a request with no matching
 *    recording throws `No snapshot found` — offline, never the network.
 *  - **Everything else, with no active cassette** → ordinary MockAgent behavior
 *    (`disableNetConnect()` → offline error). A non-recorded test never reaches
 *    the network.
 *
 * There is **no registry**: cassettes are keyed per test (file + describe + test
 * name) by the spec helper, activated one at a time over the control channel. A
 * new recorded spec touches only its own `.spec` file.
 *
 * Why `VcrAgent extends MockAgent` rather than `SnapshotAgent`: a `SnapshotAgent`'s
 * `dispatch` fully overrides `MockAgent`'s (it never falls back to the interceptor
 * path), so one `SnapshotAgent` cannot also serve the control/interceptor fixtures
 * — and cannot serve more than one cassette. Keeping one internal `SnapshotAgent`
 * per cassette and dispatching to the active one, with an ordinary
 * `MockAgent.dispatch` fallback for control/passthrough/offline, leaves the
 * interceptor path exactly as it always worked. Miniflare validates `fetchMock`
 * with `instanceof MockAgent`, which `VcrAgent` satisfies directly.
 */
export class VcrAgent extends MockAgent {
  readonly #snapshotsDir: string;
  readonly #record: boolean;
  readonly #passthrough: Set<string>;
  readonly #excludeHeaders?: string[];
  readonly #ignoreHeaders?: string[];
  /** One SnapshotAgent per cassette name, created lazily on first activation. */
  readonly #agents = new Map<string, SnapshotAgent>();
  #active: SnapshotAgent | null = null;
  #activeName: string | null = null;

  constructor(options: CreateVcrAgentOptions) {
    super();
    this.#snapshotsDir = options.snapshotsDir;
    this.#record = options.record;
    this.#passthrough = new Set(options.passthroughHosts);
    this.#excludeHeaders = options.excludeHeaders;
    this.#ignoreHeaders = options.ignoreHeaders;
    this.#registerControl();
  }

  /** Persistent interceptors backing the control channel (see class doc). */
  #registerControl(): void {
    const control = this.get(VCR_CONTROL_ORIGIN);
    control
      // RegExp path so any `?cassette=…` query matches; the name is read from
      // opts.path (the body is a ReadableStream and can't be read synchronously).
      .intercept({ path: /^\/use(\?|$)/, method: "POST" })
      .reply((opts) => this.#onUse(opts))
      .persist();
    control
      .intercept({ path: "/release", method: "POST" })
      .reply(() => {
        this.#active = null;
        this.#activeName = null;
        return { statusCode: 204 };
      })
      .persist();
  }

  /** Activate the named cassette (get-or-create its SnapshotAgent). `opts.path`
   *  is undici's reply-callback request path, e.g. `/use?cassette=<name>`. */
  #onUse(opts: { path: string }): { statusCode: number; data?: string } {
    const name =
      new URL(opts.path, VCR_CONTROL_ORIGIN).searchParams.get("cassette") ?? "";
    if (!CASSETTE_NAME_RE.test(name)) {
      return { statusCode: 400, data: `invalid cassette name: ${name}` };
    }
    // Cheap tripwire: recorded specs are expected to run sequentially, so a
    // second cassette activating while another is held means parallel recorded
    // tests are sharing this agent — surface it loudly rather than mis-record.
    if (this.#activeName !== null && this.#activeName !== name) {
      return {
        statusCode: 409,
        data: `cassette ${this.#activeName} still active`
      };
    }
    const file = path.join(this.#snapshotsDir, name);
    // Playback with no cassette → 404, which the spec turns into a "record it"
    // error. In record mode the file is created on first write.
    if (!this.#record && !existsSync(file)) {
      return { statusCode: 404, data: `no cassette ${name}` };
    }
    this.#active = this.#agentFor(name, file);
    this.#activeName = name;
    return { statusCode: 204 };
  }

  #agentFor(name: string, file: string): SnapshotAgent {
    let agent = this.#agents.get(name);
    if (!agent) {
      agent = new SnapshotAgent({
        // `"record"`, not undici's `"update"`: update mode replays any request
        // already in the cassette and only hits the network for new ones —
        // silently stale the moment recorded traffic no longer matches live
        // behavior (e.g. a re-used game id). `"record"` never loads or matches
        // existing entries, so a recording run always reflects the live API.
        mode: this.#record ? "record" : "playback",
        snapshotPath: file,
        excludeHeaders: this.#excludeHeaders,
        ignoreHeaders: this.#ignoreHeaders,
        autoFlush: this.#record
      });
      this.#agents.set(name, agent);
    }
    return agent;
  }

  dispatch(
    opts: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler
  ): boolean {
    const host = originHost(opts.origin);
    const vcr =
      host !== null &&
      host !== CONTROL_HOST &&
      !this.#passthrough.has(host) &&
      this.#active !== null;
    if (vcr) return this.#active!.dispatch(opts, handler) as boolean;
    return super.dispatch(opts, handler);
  }

  /**
   * Closes every cassette's `SnapshotAgent`, then this agent.
   *
   * Record mode: `SnapshotAgent.close()` saves each cassette, stops its
   * recorder's auto-flush timer, and closes its real sockets — all required (see
   * {@link closeVcr}). We then {@link stripVolatileFields} from each saved file
   * so the committed cassette carries no `callCount`/`timestamp`.
   *
   * Playback mode: undici's `SnapshotAgent.close()` *unconditionally* re-saves
   * the cassette, writing back the `callCount` its recorder mutates on every
   * replay — the side effect that dirtied cassettes on a plain `npm test`. There
   * is nothing to save and no real socket in playback, so we skip that save
   * entirely and only stop each recorder's timers.
   */
  async close(): Promise<void> {
    if (this.#record) {
      await Promise.all([...this.#agents.values()].map((a) => a.close()));
      for (const name of this.#agents.keys()) {
        stripVolatileFields(path.join(this.#snapshotsDir, name));
      }
    } else {
      for (const a of this.#agents.values()) a.getRecorder().destroy();
    }
    await super.close();
  }
}

export function createVcrAgent(options: CreateVcrAgentOptions): VcrAgent {
  const agent = new VcrAgent(options);
  (globalThis as Record<string, unknown>)[VCR_KEY] = agent;
  return agent;
}

/** globalThis slot so the Vitest globalSetup teardown can reach the live agent
 *  created during config evaluation (same process, possibly a different module
 *  realm — globalThis is the reliable channel). */
const VCR_KEY = "__VCR_AGENT__";

/**
 * Flush and close the active VCR agent (all its cassettes). In record mode,
 * undici's recorder arms a self-refreshing, non-`unref`ed auto-flush timer and
 * the real `SnapshotAgent` keeps sockets open — both keep the process alive
 * after tests finish and trip Vitest's "close timed out" at teardown. Calling
 * this (from a Vitest `globalSetup` teardown, which runs before Vite closes its
 * own server) stops them. A no-op if no agent was created, and in playback only
 * stops recorder timers — {@link VcrAgent.close} deliberately does not re-save
 * the cassette there (see its doc).
 */
export async function closeVcr(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const agent = g[VCR_KEY] as VcrAgent | undefined;
  if (!agent) return;
  g[VCR_KEY] = undefined;
  await agent.close();
}
