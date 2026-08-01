/**
 * `@looping/core/testing` — the harness both predecessor agents grew, shipped so
 * a consumer does not grow it a third time.
 *
 * Never import this from runtime code. It is a separate subpath precisely so it
 * cannot reach a production bundle, and it pulls in `cloudflare:test`, `undici`,
 * and `node:fs`, none of which exist in a deployed Worker.
 *
 * Three things live here:
 *
 * - **VCR** — record/replay of real HTTP against on-disk cassettes, split across
 *   the Node and workerd realms because specs run in workerd, which has no
 *   filesystem. Zero project knowledge.
 * - **Fakes** — a `SessionLike` reference implementation and a scripted
 *   `LanguageModel`, so a loop can be driven with no model call at all.
 * - **Fixtures** — Ed25519 keypairs and a gateway-JWT signer, so the zero-trust
 *   path can be exercised end to end without a real gateway.
 */

export {
  createVcrAgent,
  closeVcr,
  VcrAgent,
  type CreateVcrAgentOptions
} from "./vcr.js";
export { setupRecording, cassetteNameFor } from "./vcr-spec.js";
export { VCR_CONTROL_ORIGIN, CASSETTE_NAME_RE } from "./vcr-shared.js";

export { FakeSession } from "./fake-session.js";
export { mockModel, finalReply, type MockStep } from "./mock-model.js";

export { makeGatewayToken, type GatewayTokenOptions } from "./auth.js";
export {
  AGENT_ORIGIN,
  GATEWAY_ORIGIN,
  TEST_AGENT_PRIVATE_JWK,
  TEST_GATEWAY_PRIVATE_JWK,
  gatewayPublicJwks,
  testAgentMessage,
  testStatus,
  testTask
} from "./fixtures.js";

export { doStorage, makeDoHelpers, type DoTestHelpers } from "./do.js";
