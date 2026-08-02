import { importJWK, SignJWT } from "jose";
import { IDENTITY_CLAIM } from "../a2a/verify.js";
import { A2A_RPC_PATH } from "../a2a/card.js";
import {
  TEST_GATEWAY_PRIVATE_JWK,
  GATEWAY_ORIGIN,
  AGENT_ORIGIN
} from "./fixtures.js";

export interface GatewayTokenOptions {
  /**
   * Who the token is for. Defaults to an agent at the default RPC path
   * (`${AGENT_ORIGIN}${A2A_RPC_PATH}`), which is what a gateway mints: the
   * agent's **endpoint**, not its origin.
   *
   * Pass this explicitly when a spec mounts an agent somewhere else — an agent
   * at `/proactive/a2a` expects that string and refuses this default, which is
   * the whole point of scoping the audience to the endpoint.
   */
  audience?: string;
  issuer?: string;
  /** Relative string ("5m"), absolute epoch seconds, or Date. Past values expire the token. */
  expiresIn?: string | number | Date;
  identity?: Record<string, unknown>;
  /** Claim the identity is carried in. Defaults to core's `IDENTITY_CLAIM`. */
  identityClaim?: string;
}

/** Sign a short-lived EdDSA gateway JWT using the test gateway key. */
export async function makeGatewayToken(
  options: GatewayTokenOptions = {}
): Promise<string> {
  const privateKey = await importJWK(TEST_GATEWAY_PRIVATE_JWK, "EdDSA");
  return new SignJWT({
    [options.identityClaim ?? IDENTITY_CLAIM]: options.identity ?? {
      key: "custom:1:test-agent",
      name: "Test Agent",
      kind: "custom",
      workspaceId: 1
    }
  })
    .setProtectedHeader({
      alg: "EdDSA",
      kid: TEST_GATEWAY_PRIVATE_JWK.kid,
      jku: `${GATEWAY_ORIGIN}/.well-known/jwks.json`
    })
    .setIssuer(options.issuer ?? GATEWAY_ORIGIN)
    .setAudience(options.audience ?? `${AGENT_ORIGIN}${A2A_RPC_PATH}`)
    .setExpirationTime(options.expiresIn ?? "5m")
    .sign(privateKey);
}
