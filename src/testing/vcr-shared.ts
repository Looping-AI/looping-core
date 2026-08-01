/**
 * Constants shared between the two sides of the VCR harness that must NOT import
 * each other: the Node-side agent (`vcr.ts`, imports `undici`) and the
 * worker-side spec helper (`vcr-spec.ts`, runs in workerd). Keep this file
 * dependency-free so both realms can load it.
 */

/**
 * Reserved origin for the in-band control channel. A recorded spec `fetch`es
 * here (via the single Miniflare `fetchMock`) to tell the Node-side agent which
 * cassette is active for the current test — see `setupRecording` (vcr-spec.ts)
 * and `VcrAgent` (vcr.ts). Never a real network host.
 */
export const VCR_CONTROL_ORIGIN = "https://vcr.internal";

/**
 * Cassette filenames are derived from kebab-cased file + describe + test names
 * (see `cassetteNameFor`), so they are always lowercase `a-z0-9-` plus the
 * `.snapshot.json` suffix. Enforced on the control channel as a path-traversal
 * guard (no `/`, no `..`) before the name is joined to the snapshots dir.
 */
export const CASSETTE_NAME_RE = /^[a-z0-9-]+\.snapshot\.json$/;
