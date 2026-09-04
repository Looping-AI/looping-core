import { existsSync } from "node:fs";
import path from "node:path";
import {
  Cassette,
  replayable,
  type RecordedRequest,
  type RecordedResponse,
  type ReplayableResponse
} from "./vcr-store.js";
import {
  VCR_CONTROL_ORIGIN,
  VCR_MARKER_HEADER,
  CASSETTE_NAME_RE
} from "./vcr-shared.js";

/**
 * The **Node realm** half of the VCR harness: a Miniflare `outboundService`.
 *
 * ## Why `outboundService` and not `fetchMock`
 *
 * Miniflare 4 implemented `fetchMock` as one line of sugar over this same hook —
 * `outboundService = (req) => fetch(req, { dispatcher: fetchMock })` — and
 * Miniflare 5 dropped `fetchMock` entirely, keeping only `outboundService`.
 * `@cloudflare/vitest-pool-workers` 0.20 removed it from its override options to
 * match, saying so in as many words: *"`fetchMock`: you should use
 * `outboundService` instead"*. Targeting the hook rather than the sugar is what
 * lets one harness serve pool 0.18 through 0.20+.
 *
 * It also drops two constraints that had nothing to do with recording:
 *
 *  - **No `undici` peer.** `fetchMock` was validated with
 *    `z.instanceof(MockAgent)` against *Miniflare's own* undici, so a second copy
 *    in `node_modules` failed with `Input not instance of MockAgent` and the peer
 *    range had to track Miniflare's exact pin. `outboundService` has no
 *    `instanceof` check in either direction — a foreign `Response` is re-wrapped.
 *  - **No silent no-op.** An unknown key in the `miniflare` options is ignored,
 *    which is how a harness wired to `fetchMock` on pool 0.20 failed: every
 *    request escaped to the real network and died as `internal error;
 *    reference = …`, naming nothing. `setupRecording()` now proves the recorder
 *    answered before a test runs — see {@link VCR_MARKER_HEADER}.
 *
 * ## How a request is routed
 *
 * Every outbound `fetch()` from workerd arrives here as a standard `Request`,
 * with the true target URL already restored by Miniflare, and is dispatched on
 * host alone:
 *
 *  - **The control channel** ({@link VCR_CONTROL_ORIGIN}) — specs run in workerd
 *    and have no filesystem, so an in-band `fetch` is the only way to say which
 *    cassette the current test is using. See `setupRecording` (vcr-spec.ts).
 *  - **A {@link VcrOptions.handlers} host** — a consumer-supplied stub, for
 *    things that are fixtures rather than recordings (a gatekeeper JWKS).
 *  - **An {@link VcrOptions.allowNetworkHosts} host** — the real network, always.
 *  - **Anything else, cassette active** — recorded or replayed against it.
 *  - **Anything else, no cassette** — blocked. A test that was never wired for
 *    recording cannot reach the network by accident.
 */

/** Minimal shape of the `Request` Miniflare hands an outbound service. */
export interface VcrRequestHeaders {
  forEach(callback: (value: string, name: string) => void): void;
  get(name: string): string | null;
}

/** Minimal shape of the `Request` Miniflare hands an outbound service. */
export interface VcrRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: VcrRequestHeaders;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Structural on purpose: core does not depend on `miniflare`, and this type
 * assigns to `WorkerOptions["outboundService"]` under both Miniflare 4 and 5.
 */
export type VcrOutboundService = (request: VcrRequest) => Promise<Response>;

export interface VcrOptions {
  /** Absolute path of the cassettes directory. */
  snapshotsDir: string;
  /**
   * true → every activated cassette captures live traffic, replacing whatever
   * was there. Recording never loads the existing file first, so a recording run
   * always reflects the live API rather than half of a stale one.
   * false → replay, and no request ever leaves the machine.
   */
  record: boolean;
  /** Hosts answered by a stub instead of a cassette (e.g. a gatekeeper JWKS). */
  handlers?: Record<
    string,
    (request: VcrRequest) => Response | Promise<Response>
  >;
  /** Hosts that always reach the real network, recorded or not. */
  allowNetworkHosts?: string[];
  /** Request *and* response headers never written to a cassette (API keys, auth). */
  excludeHeaders?: string[];
}

export interface Vcr {
  /** Hand this to `cloudflareTest({ miniflare: { outboundService } })`. */
  readonly outboundService: VcrOutboundService;
  /** Flush every cassette. Safe to call more than once. */
  close(): Promise<void>;
}

const CONTROL_HOST = new URL(VCR_CONTROL_ORIGIN).host;

/**
 * Request headers dropped before a live call. `host` and `content-length` are
 * recomputed by the outgoing fetch and a stale value corrupts it;
 * `accept-encoding` is dropped so the body arrives as plaintext to store; the
 * rest are hop-by-hop or Miniflare's own loopback bookkeeping.
 */
const SKIP_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function headerRecord(headers: VcrRequestHeaders): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    record[name.toLowerCase()] = value;
  });
  return record;
}

/** `set-cookie` is the one header `forEach` folds together destructively. */
function responseHeaderRecord(
  headers: Headers
): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {};
  headers.forEach((value, name) => {
    record[name.toLowerCase()] = value;
  });
  const cookies = headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) record["set-cookie"] = cookies;
  return record;
}

/**
 * The one place a `Response` is built, so recording and replaying a given
 * cassette entry cannot disagree about it.
 *
 * `Response` rejects *any* non-null body on 204/205/304 — an empty `Uint8Array`
 * throws just as a full one does — so a recorded 204 has to be handed back with
 * a null body or it cannot be replayed at all.
 */
function toResponse({ status, headers, body }: ReplayableResponse): Response {
  const nullBody = status === 204 || status === 205 || status === 304;
  return new Response(nullBody ? null : body, { status, headers });
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      [VCR_MARKER_HEADER]: "1"
    }
  });
}

class Recorder {
  readonly #snapshotsDir: string;
  readonly #record: boolean;
  readonly #handlers: NonNullable<VcrOptions["handlers"]>;
  readonly #allowNetwork: Set<string>;
  readonly #excludeHeaders: string[];
  /** One cassette per name, created on first activation. */
  readonly #cassettes = new Map<string, Cassette>();
  #active: Cassette | null = null;
  #activeName: string | null = null;
  /** Requests that could not be served since the active cassette was set. */
  #misses: string[] = [];

  constructor(options: VcrOptions) {
    this.#snapshotsDir = options.snapshotsDir;
    this.#record = options.record;
    this.#handlers = options.handlers ?? {};
    this.#allowNetwork = new Set(options.allowNetworkHosts ?? []);
    this.#excludeHeaders = options.excludeHeaders ?? [];
  }

  handle = async (request: VcrRequest): Promise<Response> => {
    const url = new URL(request.url);
    if (url.host === CONTROL_HOST) return this.#control(url);

    const handler = this.#handlers[url.host];
    if (handler) return handler(request);

    // Read once: the body is needed to key the cassette *and* to forward.
    const bytes = Buffer.from(await request.arrayBuffer());
    if (this.#allowNetwork.has(url.host)) return this.#live(request, bytes);

    const body = bytes.toString("utf8");
    const what = `${request.method} ${request.url}`;

    if (this.#active === null) {
      this.#misses.push(what);
      return this.#blocked(
        `VCR blocked ${what}: no cassette is active for this test. ` +
          `Call setupRecording() at the top of the spec, or add the host to ` +
          `allowNetworkHosts / handlers.`
      );
    }

    if (this.#record) return this.#recordOne(request, bytes);

    const hit = this.#active.match(request.method, request.url, body);
    if (hit) return toResponse(hit);

    this.#misses.push(what);
    return this.#blocked(
      `VCR has no recording of ${what} in ${path.basename(this.#active.file)}. ` +
        `Re-record with RECORD=1. The cassette holds: ` +
        `${this.#active.recorded.join(", ") || "(nothing)"}.`
    );
  };

  /**
   * A miss cannot be made to *reject* the Worker's `fetch()` — Miniflare catches
   * whatever an outbound service throws and turns it into a 500 anyway. So the
   * message goes in the body where it can be read, and the miss is also reported
   * on `/release` so the test itself fails with it. That is the half the old
   * harness lacked: `disableNetConnect()` rejected, and the rejection surfaced
   * as `internal error; reference = …` naming nothing.
   */
  #blocked(message: string): Response {
    return new Response(message, {
      status: 500,
      headers: { [VCR_MARKER_HEADER]: "1" }
    });
  }

  #control(url: URL): Response {
    if (url.pathname === "/release") {
      const misses = this.#misses;
      // Write here rather than only at teardown, so a run that is interrupted
      // still keeps every cassette whose test finished. A no-op in playback:
      // `flush()` returns immediately unless something was recorded.
      this.#active?.flush();
      this.#active = null;
      this.#activeName = null;
      this.#misses = [];
      return json(200, { misses });
    }
    if (url.pathname !== "/use") return json(404, { error: "unknown" });

    const name = url.searchParams.get("cassette") ?? "";
    if (!CASSETTE_NAME_RE.test(name)) {
      return json(400, { error: `invalid cassette name: ${name}` });
    }
    // Recorded specs are expected to run sequentially: a second cassette
    // activating while one is held means two of them are sharing this recorder,
    // which mis-records rather than failing, so say so instead.
    if (this.#activeName !== null && this.#activeName !== name) {
      return json(409, { error: `cassette ${this.#activeName} still active` });
    }
    const file = path.join(this.#snapshotsDir, name);
    // Playback with no cassette on disk → 404, which the spec turns into a
    // "record it" failure. Recording creates the file on first write.
    if (!this.#record && !existsSync(file)) {
      return json(404, { error: `no cassette ${name}` });
    }
    this.#active = this.#cassetteFor(name, file);
    this.#activeName = name;
    this.#misses = [];
    return json(200, { cassette: name });
  }

  #cassetteFor(name: string, file: string): Cassette {
    let cassette = this.#cassettes.get(name);
    if (!cassette) {
      cassette = new Cassette(file, { excludeHeaders: this.#excludeHeaders });
      // Recording deliberately starts from nothing rather than topping up an
      // existing file: a cassette that mixes today's traffic with last month's
      // is stale in a way no assertion can see.
      if (!this.#record) cassette.load();
      this.#cassettes.set(name, cassette);
    }
    return cassette;
  }

  /** The real call, with the headers the Worker sent minus the unforwardable. */
  #live(request: VcrRequest, body: Buffer): Promise<Response> {
    const headers: [string, string][] = [];
    request.headers.forEach((value, name) => {
      if (!SKIP_REQUEST_HEADERS.has(name.toLowerCase())) {
        headers.push([name, value]);
      }
    });
    return fetch(request.url, {
      method: request.method,
      headers,
      body: body.byteLength > 0 ? body : undefined,
      // Matches what Miniflare's own `fetch(req, { dispatcher })` sugar did, so
      // a recording captures the same final response the Worker used to see.
      redirect: "follow"
    });
  }

  /**
   * `requestBytes` is forwarded to the live endpoint **as received**. The
   * cassette stores the utf-8 text of it, which is what the format has always
   * held and what keys the entry — but a payload that is not valid utf-8 must
   * not be re-encoded on its way to a real API, so the two are kept separate
   * rather than the string being round-tripped back into bytes.
   */
  async #recordOne(
    request: VcrRequest,
    requestBytes: Buffer
  ): Promise<Response> {
    const live = await this.#live(request, requestBytes);
    const bytes = Buffer.from(await live.arrayBuffer());
    const recordedRequest: RecordedRequest = {
      method: request.method,
      url: request.url,
      headers: headerRecord(request.headers),
      body: requestBytes.toString("utf8")
    };
    const recordedResponse: RecordedResponse = {
      statusCode: live.status,
      headers: responseHeaderRecord(live.headers),
      body: bytes.toString("base64")
    };
    this.#active!.record(recordedRequest, recordedResponse);
    // Serve the response through the same path a replay takes, so a recording
    // run and the replay of what it just wrote cannot disagree.
    return toResponse(replayable(recordedResponse));
  }

  async close(): Promise<void> {
    for (const cassette of this.#cassettes.values()) cassette.flush();
  }
}

/**
 * Build the recorder and register it for {@link closeVcr}.
 *
 * ```ts
 * // vitest.config.ts
 * const vcr = createVcr({
 *   snapshotsDir: path.resolve(import.meta.dirname, "test/snapshots"),
 *   record: recordFromEnv(),
 *   excludeHeaders: ["x-api-key", "authorization", "cookie", "set-cookie"]
 * });
 *
 * export default defineConfig({
 *   plugins: [cloudflareTest({ miniflare: { outboundService: vcr.outboundService } })],
 *   test: { globalSetup: ["@dynamicagents/core/testing/vcr-global-setup"] }
 * });
 * ```
 */
export function createVcr(options: VcrOptions): Vcr {
  const recorder = new Recorder(options);
  const vcr: Vcr = {
    outboundService: recorder.handle,
    close: () => recorder.close()
  };
  (globalThis as Record<string, unknown>)[VCR_KEY] = vcr;
  return vcr;
}

/**
 * Whether this run records, from `RECORD`.
 *
 * Compared against `"1"` rather than tested for truthiness, because every
 * non-empty string is truthy: `RECORD=0` and `RECORD=false` — the two things
 * someone reaches for to turn recording *off* — would otherwise turn it on and
 * overwrite committed cassettes with live traffic. The opposite mistake
 * (`RECORD=true` not recording) fails loudly on the next assertion and costs
 * nothing.
 */
export function recordFromEnv(): boolean {
  return process.env.RECORD === "1";
}

/** globalThis slot so the Vitest globalSetup teardown can reach the recorder
 *  created during config evaluation (same process, possibly a different module
 *  realm — globalThis is the reliable channel). */
const VCR_KEY = "__VCR_AGENT__";

/**
 * Flush every cassette. Cassettes are already written when each one is
 * released, so this is a safety net for a run that ended without releasing —
 * and a no-op if no recorder was created.
 */
export async function closeVcr(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const vcr = g[VCR_KEY] as Vcr | undefined;
  if (!vcr) return;
  g[VCR_KEY] = undefined;
  await vcr.close();
}
