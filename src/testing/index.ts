/**
 * `@looping/core/testing` — the harness both predecessor agents grew, shipped so
 * a consumer does not grow it a third time.
 *
 * Never import this from runtime code. It is a separate subpath precisely so it
 * cannot reach a production bundle, and it pulls in `cloudflare:test`, which
 * does not exist in a deployed Worker.
 *
 * **This barrel is the workerd half** — safe to import from a spec. The VCR
 * recorder needs `undici` and `node:fs`, so it lives behind
 * `@looping/core/testing/node` and must not be re-exported here: pulling it into
 * this graph would drag Node builtins into every spec that wanted a fixture.
 * `vcr-shared.ts` is the seam both realms may load.
 *
 * Three things live here:
 *
 * - **VCR (spec side)** — `setupRecording()`, which names a cassette per test and
 *   talks to the Node-side recorder over the in-band control channel.
 * - **Fakes** — a `SessionLike` reference implementation and a scripted
 *   `LanguageModel`, so a loop can be driven with no model call at all.
 * - **Fixtures** — Ed25519 keypairs and a gateway-JWT signer, so the zero-trust
 *   path can be exercised end to end without a real gateway.
 */

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
