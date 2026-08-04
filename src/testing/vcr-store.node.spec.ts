/**
 * Node-realm spec (`*.node.spec.ts` — see `vitest.config.ts`): the cassette store
 * touches `node:fs` and never `cloudflare:test`, so it runs outside workerd.
 *
 * The properties pinned here are the ones that decide whether a committed
 * cassette survives a runtime upgrade, which is the defect that made the old
 * harness a blocker on bumping `@cloudflare/vitest-pool-workers`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cassette, requestKey } from "./vcr-store.js";

const b64 = (s: string): string => Buffer.from(s).toString("base64");
const text = (r: { body: Uint8Array }): string =>
  Buffer.from(r.body).toString("utf8");

/** An entry in the exact shape undici's `SnapshotAgent` wrote. */
function legacyEntry(
  request: Partial<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  }>,
  bodies: string[]
) {
  return {
    hash: "ignored-legacy-hash",
    snapshot: {
      request: {
        method: "GET",
        url: "https://api.test/thing",
        headers: {},
        body: "",
        ...request
      },
      responses: bodies.map((body) => ({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: b64(body)
      })),
      callCount: 3,
      timestamp: "2026-07-29T09:25:11.000Z"
    }
  };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vcr-store-"));
  file = path.join(dir, "spec.snapshot.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (entries: unknown[]): void =>
  writeFileSync(file, JSON.stringify(entries, null, 2));

describe("Cassette.load", () => {
  it("replays a cassette written by undici's SnapshotAgent", () => {
    // The one committed cassette in looping-plugins is in this format, and
    // re-recording it needs a live ARC key — so reading it is not optional.
    write([legacyEntry({}, ["hello"])]);
    const cassette = new Cassette(file);
    cassette.load();

    const hit = cassette.match("GET", "https://api.test/thing", "");
    expect(hit).not.toBeNull();
    expect(text(hit!)).toBe("hello");
  });

  it("matches regardless of the request headers the recording carried", () => {
    // The whole reason for the rewrite. SnapshotAgent hashed every non-excluded
    // header, so a cassette recorded through one pool version stopped matching
    // under the next one — `cf-worker` and `user-agent` alone were enough.
    write([
      legacyEntry(
        {
          headers: {
            "user-agent": "undici",
            "cf-worker": "vitest-pool-workers-runner-.example.com",
            "sec-fetch-mode": "cors"
          }
        },
        ["survives"]
      )
    ]);
    const cassette = new Cassette(file);
    cassette.load();

    // Nothing about the caller's headers is passed to `match` at all.
    expect(text(cassette.match("GET", "https://api.test/thing", "")!)).toBe(
      "survives"
    );
  });

  it("merges legacy entries that differed only by a request header", () => {
    // Two hashes under SnapshotAgent, one key here. Their responses concatenate
    // in file order, which is the sequential-response semantics `match` walks —
    // so no recording is lost in the collapse.
    write([
      legacyEntry({ headers: { "user-agent": "a" } }, ["first"]),
      legacyEntry({ headers: { "user-agent": "b" } }, ["second"])
    ]);
    const cassette = new Cassette(file);
    cassette.load();

    expect(text(cassette.match("GET", "https://api.test/thing", "")!)).toBe(
      "first"
    );
    expect(text(cassette.match("GET", "https://api.test/thing", "")!)).toBe(
      "second"
    );
  });

  it("keeps requests apart by body", () => {
    write([
      legacyEntry({ method: "POST", body: '{"a":1}' }, ["one"]),
      legacyEntry({ method: "POST", body: '{"a":2}' }, ["two"])
    ]);
    const cassette = new Cassette(file);
    cassette.load();

    expect(
      text(cassette.match("POST", "https://api.test/thing", '{"a":2}')!)
    ).toBe("two");
    expect(
      text(cassette.match("POST", "https://api.test/thing", '{"a":1}')!)
    ).toBe("one");
  });

  it("returns null for a request that was never recorded", () => {
    write([legacyEntry({}, ["hello"])]);
    const cassette = new Cassette(file);
    cassette.load();

    expect(cassette.match("GET", "https://api.test/other", "")).toBeNull();
    expect(cassette.match("POST", "https://api.test/thing", "")).toBeNull();
  });

  it("is empty, not an error, when the file does not exist", () => {
    const cassette = new Cassette(path.join(dir, "absent.snapshot.json"));
    cassette.load();
    expect(cassette.match("GET", "https://api.test/thing", "")).toBeNull();
    expect(cassette.recorded).toEqual([]);
  });
});

describe("Cassette.match", () => {
  it("walks sequential responses, then holds the last one", () => {
    // A poll loop issues the same request repeatedly and must see the recorded
    // progression; once it runs out, repeating the final response is what lets
    // a one-response recording serve a loop that runs a different number of
    // times on replay than it did while recording.
    write([legacyEntry({}, ["frame-1", "frame-2"])]);
    const cassette = new Cassette(file);
    cassette.load();

    const bodies = Array.from({ length: 4 }, () =>
      text(cassette.match("GET", "https://api.test/thing", "")!)
    );
    expect(bodies).toEqual(["frame-1", "frame-2", "frame-2", "frame-2"]);
  });

  it("strips the headers that describe wire framing", () => {
    // Bodies are stored decoded and handed back whole. Replaying
    // `transfer-encoding: chunked` mis-frames the response and
    // `content-encoding: gzip` makes the consumer try to inflate plaintext —
    // the committed ARC cassette carries both kinds of header.
    write([
      {
        snapshot: {
          request: {
            method: "GET",
            url: "https://api.test/thing",
            headers: {},
            body: ""
          },
          responses: [
            {
              statusCode: 200,
              headers: {
                "content-type": "application/json",
                "transfer-encoding": "chunked",
                connection: "keep-alive",
                "content-encoding": "gzip",
                "content-length": "999"
              },
              body: b64("{}")
            }
          ]
        }
      }
    ]);
    const cassette = new Cassette(file);
    cassette.load();

    const names = cassette
      .match("GET", "https://api.test/thing", "")!
      .headers.map(([name]) => name);
    expect(names).toEqual(["content-type"]);
  });

  it("expands a repeated response header into one entry per value", () => {
    write([
      {
        snapshot: {
          request: {
            method: "GET",
            url: "https://api.test/thing",
            headers: {},
            body: ""
          },
          responses: [
            {
              statusCode: 200,
              headers: { "set-cookie": ["a=1", "b=2"] },
              body: b64("{}")
            }
          ]
        }
      }
    ]);
    const cassette = new Cassette(file);
    cassette.load();

    expect(
      cassette.match("GET", "https://api.test/thing", "")!.headers
    ).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"]
    ]);
  });

  it("carries the recorded status through", () => {
    write([
      {
        snapshot: {
          request: {
            method: "GET",
            url: "https://api.test/thing",
            headers: {},
            body: ""
          },
          responses: [{ statusCode: 429, headers: {}, body: b64("slow down") }]
        }
      }
    ]);
    const cassette = new Cassette(file);
    cassette.load();
    expect(cassette.match("GET", "https://api.test/thing", "")!.status).toBe(
      429
    );
  });
});

describe("Cassette.flush", () => {
  const request = {
    method: "POST",
    url: "https://api.test/thing",
    headers: { "x-api-key": "super-secret", accept: "application/json" },
    body: '{"a":1}'
  };
  const response = {
    statusCode: 200,
    headers: {
      "set-cookie": "session=super-secret",
      "content-type": "text/plain"
    },
    body: b64("ok")
  };

  it("writes nothing on a pure playback run", () => {
    // The failure this pins: SnapshotAgent re-saved unconditionally on close,
    // writing back the callCount it mutated on every replay, so a plain
    // `npm test` left every committed cassette modified in git.
    write([legacyEntry({}, ["hello"])]);
    const before = readFileSync(file, "utf8");

    const cassette = new Cassette(file);
    cassette.load();
    cassette.match("GET", "https://api.test/thing", "");
    cassette.match("GET", "https://api.test/thing", "");
    cassette.flush();

    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("keeps excluded headers out of the file, on both sides", () => {
    // This is what makes a cassette safe to commit, and why playback needs no
    // credentials at all.
    const cassette = new Cassette(file, {
      excludeHeaders: ["x-api-key", "set-cookie"]
    });
    cassette.record(request, response);
    cassette.flush();

    const written = readFileSync(file, "utf8");
    expect(written).not.toContain("super-secret");
    expect(written).toContain("accept");
    expect(written).toContain("content-type");
  });

  it("round-trips what it wrote", () => {
    const cassette = new Cassette(file);
    cassette.record(request, response);
    cassette.flush();

    const replayed = new Cassette(file);
    replayed.load();
    const hit = replayed.match("POST", "https://api.test/thing", '{"a":1}');
    expect(hit).not.toBeNull();
    expect(text(hit!)).toBe("ok");
  });

  it("appends a repeat of the same request as a second response", () => {
    const cassette = new Cassette(file);
    cassette.record(request, response);
    cassette.record(request, { ...response, body: b64("again") });
    cassette.flush();

    const replayed = new Cassette(file);
    replayed.load();
    expect(text(replayed.match("POST", request.url, request.body)!)).toBe("ok");
    expect(text(replayed.match("POST", request.url, request.body)!)).toBe(
      "again"
    );
  });

  it("writes the `snapshot` wrapper, without the volatile bookkeeping", () => {
    // Same wrapper SnapshotAgent used, so re-recording an old cassette diffs as
    // content rather than as a reshape of the whole file. `hash` is gone
    // because the key is derived, and `callCount`/`timestamp` because neither
    // is needed to replay and both churned the file on every run.
    const cassette = new Cassette(file);
    cassette.record(request, response);
    cassette.flush();

    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      snapshot: Record<string, unknown>;
    }[];
    expect(Object.keys(parsed[0])).toEqual(["snapshot"]);
    expect(Object.keys(parsed[0].snapshot)).toEqual(["request", "responses"]);
  });
});

describe("requestKey", () => {
  it("is insensitive to method case and nothing else", () => {
    const key = requestKey("get", "https://api.test/x", "");
    expect(requestKey("GET", "https://api.test/x", "")).toBe(key);
    expect(requestKey("GET", "https://api.test/y", "")).not.toBe(key);
    expect(requestKey("POST", "https://api.test/x", "")).not.toBe(key);
    expect(requestKey("GET", "https://api.test/x", "body")).not.toBe(key);
  });

  it("keeps query strings significant", () => {
    expect(requestKey("GET", "https://api.test/x?a=1", "")).not.toBe(
      requestKey("GET", "https://api.test/x?a=2", "")
    );
  });
});
