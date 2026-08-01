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
 * ```
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
