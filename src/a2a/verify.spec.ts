import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { importJWK, SignJWT } from "jose";
import {
  GatewayAuthError,
  IDENTITY_CLAIM,
  bearerToken,
  normalizeGatewayOrigins,
  verifyGatewayToken
} from "./verify.js";
import { makeGatewayToken } from "../testing/auth.js";
import {
  AGENT_ORIGIN,
  GATEWAY_ORIGIN,
  TEST_GATEWAY_PRIVATE_JWK,
  gatewayPublicJwks
} from "../testing/fixtures.js";

/**
 * The rejection matrix for the zero-trust contract.
 *
 * `verify.ts` calls itself a guardian: its four checks — `jku` present → origin
 * allowlist → `iss` origin equals `jku` origin → `jwtVerify` pinned to EdDSA —
 * arrived byte-identical from two independently-evolved predecessor agents, and
 * they are the entire reason an agent can trust a caller it has no shared secret
 * with. Every one of them is asserted below, negatively. A change that makes any
 * check optional, or adds a local-development bypass, has to delete a test here
 * to land — which is the point.
 */

const JWKS_URL = `${GATEWAY_ORIGIN}/.well-known/jwks.json`;
const ALLOWED = [GATEWAY_ORIGIN];

/**
 * `createRemoteJWKSet` fetches the gateway's public keys over the network. Serve
 * them from a stub so the specs are hermetic — and so `jwksFetches` can prove the
 * allowlist check happens *before* the fetch, not after.
 */
let jwksFetches: string[] = [];

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    jwksFetches.push(url);
    if (url === JWKS_URL) {
      return new Response(gatewayPublicJwks(), {
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("verifyGatewayToken", () => {
  it("accepts a well-formed gateway token and returns the caller identity", async () => {
    const token = await makeGatewayToken();

    const { payload, identity } = await verifyGatewayToken(token, {
      allowedOrigins: ALLOWED,
      audience: AGENT_ORIGIN
    });

    expect(payload.iss).toBe(GATEWAY_ORIGIN);
    expect(payload.aud).toBe(AGENT_ORIGIN);
    // `key` is the only field anything downstream depends on.
    expect(identity.key).toBe("custom:1:test-agent");
    expect(identity.workspaceId).toBe(1);
  });

  it("rejects a token with no jku header (RFC 7515 §4.1.2)", async () => {
    const privateKey = await importJWK(TEST_GATEWAY_PRIVATE_JWK, "EdDSA");
    const token = await new SignJWT({ [IDENTITY_CLAIM]: { key: "k" } })
      // No `jku` — the agent has nowhere to fetch keys from, and must not
      // fall back to a configured default.
      .setProtectedHeader({ alg: "EdDSA", kid: TEST_GATEWAY_PRIVATE_JWK.kid })
      .setIssuer(GATEWAY_ORIGIN)
      .setAudience(AGENT_ORIGIN)
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(
      verifyGatewayToken(token, {
        allowedOrigins: ALLOWED,
        audience: AGENT_ORIGIN
      })
    ).rejects.toThrow(/missing jku/i);
  });

  it("rejects a jku origin outside the allowlist without fetching it", async () => {
    // The key-injection attack: a valid signature over attacker-chosen keys.
    // Allowing an unlisted origin here would make the whole scheme decorative.
    const token = await makeGatewayToken();
    jwksFetches = [];

    await expect(
      verifyGatewayToken(token, {
        allowedOrigins: ["https://not-the-gateway.test"],
        audience: AGENT_ORIGIN
      })
    ).rejects.toThrow(/not in the allowed gateway origins/i);

    // Order matters as much as the check: validate, *then* fetch.
    expect(jwksFetches).toEqual([]);
  });

  it("rejects when iss origin does not match jku origin", async () => {
    // Both origins are allowlisted, so this is the check that stops one listed
    // gateway from minting tokens that appear to come from another.
    const token = await makeGatewayToken({ issuer: "https://evil.test" });

    await expect(
      verifyGatewayToken(token, {
        allowedOrigins: [GATEWAY_ORIGIN, "https://evil.test"],
        audience: AGENT_ORIGIN
      })
    ).rejects.toThrow(/does not match iss origin/i);
  });

  it("rejects a token signed with something other than EdDSA", async () => {
    const token = await new SignJWT({ [IDENTITY_CLAIM]: { key: "k" } })
      .setProtectedHeader({
        alg: "HS256",
        kid: TEST_GATEWAY_PRIVATE_JWK.kid,
        jku: JWKS_URL
      })
      .setIssuer(GATEWAY_ORIGIN)
      .setAudience(AGENT_ORIGIN)
      .setExpirationTime("5m")
      .sign(new Uint8Array(32));

    await expect(
      verifyGatewayToken(token, {
        allowedOrigins: ALLOWED,
        audience: AGENT_ORIGIN
      })
    ).rejects.toThrow(GatewayAuthError);
  });

  it("rejects an expired token", async () => {
    const token = await makeGatewayToken({ expiresIn: "-1m" });

    await expect(
      verifyGatewayToken(token, {
        allowedOrigins: ALLOWED,
        audience: AGENT_ORIGIN
      })
    ).rejects.toThrow(GatewayAuthError);
  });

  it("rejects a token whose signature has been tampered with", async () => {
    const token = await makeGatewayToken();
    const [header, body, sig] = token.split(".");
    const flipped = sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;

    await expect(
      verifyGatewayToken(`${header}.${body}.${flipped}`, {
        allowedOrigins: ALLOWED,
        audience: AGENT_ORIGIN
      })
    ).rejects.toThrow(GatewayAuthError);
  });

  it("rejects a token minted for a different audience", async () => {
    const token = await makeGatewayToken({
      audience: "https://elsewhere.test"
    });

    await expect(
      verifyGatewayToken(token, {
        allowedOrigins: ALLOWED,
        audience: AGENT_ORIGIN
      })
    ).rejects.toThrow(GatewayAuthError);
  });

  it("reads the identity from a configured non-default claim", async () => {
    // The claim is configurable for deployments not behind looping-gateway;
    // the *checks* above are not.
    const claim = "https://example.test/identity";
    const token = await makeGatewayToken({
      identityClaim: claim,
      identity: { key: "custom:9:other" }
    });

    const { identity } = await verifyGatewayToken(token, {
      allowedOrigins: ALLOWED,
      audience: AGENT_ORIGIN,
      identityClaim: claim
    });

    expect(identity.key).toBe("custom:9:other");
  });

  it("yields an empty identity when the claim is absent, rather than throwing", async () => {
    // Downstream rejects a caller with no `key`; verification itself stays a
    // pure signature/origin question.
    const token = await makeGatewayToken({
      identityClaim: "https://example.test/somewhere-else"
    });

    const { identity } = await verifyGatewayToken(token, {
      allowedOrigins: ALLOWED,
      audience: AGENT_ORIGIN
    });

    expect(identity).toEqual({});
  });
});

describe("normalizeGatewayOrigins", () => {
  it("accepts a bare hostname, an http URL, and a trailing slash alike", () => {
    expect(
      normalizeGatewayOrigins([
        "gateway.test",
        "http://gateway.test",
        "https://gateway.test/"
      ])
    ).toEqual([GATEWAY_ORIGIN, GATEWAY_ORIGIN, GATEWAY_ORIGIN]);
  });

  it("keeps the allowlist exact rather than matching by suffix", () => {
    // `evil-gateway.test` must never satisfy an allowlist entry of
    // `gateway.test`; normalization is to an origin, not to a pattern.
    const [normalized] = normalizeGatewayOrigins(["gateway.test"]);
    expect(normalized).not.toBe("https://evil-gateway.test");
    expect(normalizeGatewayOrigins(["evil-gateway.test"])).toEqual([
      "https://evil-gateway.test"
    ]);
  });

  it("rejects an empty or unparseable origin loudly", () => {
    expect(() => normalizeGatewayOrigins([""])).toThrow(GatewayAuthError);
    expect(() => normalizeGatewayOrigins(["   "])).toThrow(GatewayAuthError);
  });
});

describe("bearerToken", () => {
  it("extracts a Bearer token case-insensitively", () => {
    const req = (auth: string) =>
      new Request("https://agent.test", { headers: { authorization: auth } });

    expect(bearerToken(req("Bearer abc.def.ghi"))).toBe("abc.def.ghi");
    expect(bearerToken(req("bearer abc.def.ghi"))).toBe("abc.def.ghi");
  });

  it("returns null when the header is missing or not a Bearer scheme", () => {
    expect(bearerToken(new Request("https://agent.test"))).toBeNull();
    expect(
      bearerToken(
        new Request("https://agent.test", {
          headers: { authorization: "Basic dXNlcjpwYXNz" }
        })
      )
    ).toBeNull();
  });
});
