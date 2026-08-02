/**
 * `@loopingai/core/testing/node` — the **Node-realm** half of the VCR harness.
 *
 * Separate from `@loopingai/core/testing` because the two halves cannot share a
 * module graph. This side imports `undici` and `node:fs`; the other side runs
 * inside workerd, which has neither. `vcr-shared.ts` is the only thing both may
 * touch, and it is deliberately dependency-free so it can load in either realm.
 *
 * Import this from a Vitest **config** (or anything else running in Node), never
 * from a spec:
 *
 * ```ts
 * // vitest.config.ts
 * import { createVcrAgent } from "@loopingai/core/testing/node";
 *
 * export default defineConfig({
 *   plugins: [cloudflareTest({ miniflare: { fetchMock: createVcrAgent({ … }) } })],
 *   test: { globalSetup: ["@loopingai/core/testing/vcr-global-setup"] }
 * });
 * ```
 *
 * ## Two version constraints, both of which fail unreadably
 *
 * **1. `@cloudflare/vitest-pool-workers` must be `^0.18`.** The recorder is
 * installed as Miniflare's `fetchMock`, and that option **does not exist in
 * Miniflare 5**, which pool `0.19`+ depends on — only `outboundService` remains.
 * On a newer pool the option is silently ignored rather than rejected, so
 * `disableNetConnect()` never takes effect, every request goes to the real
 * network, and each one fails as `internal error; reference = …` naming nothing.
 * That is why the peer range is pinned rather than open.
 *
 * **2. Your `undici` must be the copy Miniflare uses.** `fetchMock` is an undici
 * `MockAgent` and Miniflare validates it against *its own* undici, so two copies
 * in one `node_modules` fail with `Input not instance of MockAgent`. Miniflare
 * pins an exact version (7.28.0 at the time of writing) and this package's
 * `undici` peer range tracks it. Check with
 * `ls node_modules/miniflare/node_modules/undici` — anything there means a
 * second copy, and the fix is to align yours rather than to debug the message.
 *
 * For the common case — wiring cassette flush/teardown — you do not need this
 * subpath at all. Point `globalSetup` at
 * `@loopingai/core/testing/vcr-global-setup`, which is this module's `setup`/
 * `teardown` pair already packaged for Vitest.
 */

export {
  createVcrAgent,
  closeVcr,
  VcrAgent,
  type CreateVcrAgentOptions
} from "./vcr.js";

export { VCR_CONTROL_ORIGIN, CASSETTE_NAME_RE } from "./vcr-shared.js";
