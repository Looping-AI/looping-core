/**
 * The VCR harness, end to end, inside workerd.
 *
 * This spec exists because of a specific failure: the recorder was installed as
 * Miniflare's `fetchMock`, `@cloudflare/vitest-pool-workers` 0.20 removed that
 * option, an unknown key in the `miniflare` options is *ignored* rather than
 * rejected — and nothing here noticed, because core published the harness
 * without ever running it. It only surfaced in a consumer, as
 * `internal error; reference = …` naming nothing.
 *
 * So what is pinned here is the wiring, not the store: a real `fetch()` from
 * inside the Workers runtime has to come out of a committed cassette. Anything
 * that breaks the workerd → `outboundService` → cassette path fails this file,
 * in core, on a plain `npm test`, with no credentials and no network.
 *
 * The cassette under `test/snapshots/` is hand-written for exactly that reason.
 * The store's own behaviour is covered in `vcr-store.node.spec.ts`, and the
 * recorder's in `vcr.node.spec.ts`, both in the Node realm.
 */
import { describe, it, expect } from "vitest";
import { setupRecording } from "./vcr-spec.js";

setupRecording();

describe("vcr", () => {
  it("replays a recorded response", async () => {
    const res = await fetch("https://api.example/greeting");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ hello: "world" });
  });

  it("matches on method, url and body rather than headers", async () => {
    // The cassette records no `x-request-id` and a different `user-agent` than
    // workerd sends. Under undici's SnapshotAgent both were part of the hash, so
    // a cassette stopped matching whenever the runtime changed what it sent —
    // which is what made every committed cassette version-locked.
    const res = await fetch("https://api.example/echo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": crypto.randomUUID()
      },
      body: JSON.stringify({ ping: true })
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ pong: true });
  });

  it("walks a recorded sequence, then holds the last response", async () => {
    // Two identical requests that returned different things are one entry with
    // two responses. Running out of them repeats the last, so a loop that
    // iterates more often on replay than it did while recording still finishes.
    const poll = async (): Promise<string> =>
      (await fetch("https://api.example/poll")).text();

    expect(await poll()).toBe("pending");
    expect(await poll()).toBe("done");
    expect(await poll()).toBe("done");
  });

  it("carries a recorded error status through unchanged", async () => {
    const res = await fetch("https://api.example/rate-limited");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("2");
  });
});
