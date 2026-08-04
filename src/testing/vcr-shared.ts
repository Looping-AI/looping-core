/**
 * Constants shared between the two sides of the VCR harness that must NOT import
 * each other: the Node-side recorder (`vcr.ts` / `vcr-store.ts`, which reach
 * `node:fs`) and the worker-side spec helper (`vcr-spec.ts`, which runs in
 * workerd). Keep this file dependency-free so both realms can load it.
 */

/**
 * Reserved origin for the in-band control channel. A recorded spec `fetch`es
 * here — through the same Miniflare `outboundService` every worker fetch already
 * flows through — to tell the Node-side recorder which cassette is active for
 * the current test. See `setupRecording` (vcr-spec.ts) and `createVcr` (vcr.ts).
 * Never a real network host.
 */
export const VCR_CONTROL_ORIGIN = "https://vcr.internal";

/**
 * Stamped on every response the recorder produces.
 *
 * The point is to prove the recorder is *installed*. A Miniflare option that no
 * longer exists is silently ignored rather than rejected — which is exactly how
 * a harness still wired to `fetchMock` on pool 0.20 failed: nothing intercepted
 * anything, every request escaped to the real network, and each one died as
 * `internal error; reference = …` naming nothing. Checking for this header on
 * the control response turns that whole class of failure into one named error
 * before any test runs.
 */
export const VCR_MARKER_HEADER = "x-vcr";

/** Body of a successful `POST /release`: what the recorder could not serve. */
export interface VcrReleaseResult {
  /** `"<METHOD> <url>"` for each blocked or unmatched request in the test. */
  misses: string[];
}

/**
 * Cassette filenames are derived from kebab-cased file + describe + test names
 * (see `cassetteNameFor`), so they are always lowercase `a-z0-9-` plus the
 * `.snapshot.json` suffix. Enforced on the control channel as a path-traversal
 * guard (no `/`, no `..`) before the name is joined to the snapshots dir.
 */
export const CASSETTE_NAME_RE = /^[a-z0-9-]+\.snapshot\.json$/;
