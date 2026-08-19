import { describe, it, expect } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  A2A_JWS_ALG,
  IDENTITY_CLAIM,
  TENANT_CLAIM,
  jwksUrl
} from "@loopingai/a2a-protocol";
import { signCallerToken } from "./caller-token.js";
import { AGENT_ORIGIN, TEST_AGENT_PRIVATE_JWK } from "../testing/fixtures.js";

const options = {
  signingKey: JSON.stringify(TEST_AGENT_PRIVATE_JWK),
  issuer: AGENT_ORIGIN,
  audience: "https://proxy.example.com",
  identity: { key: "looping:coder:x", name: "Coder", kind: "agent" },
  tenant: "coder"
};

describe("signCallerToken", () => {
  it("carries the identity and tenant claims a verifier reads", async () => {
    const claims = decodeJwt(await signCallerToken(options));

    expect(claims[IDENTITY_CLAIM]).toEqual(options.identity);
    expect(claims[TENANT_CLAIM]).toBe("coder");
    expect(claims.iss).toBe(AGENT_ORIGIN);
  });

  /**
   * The header must name the same origin as `iss`. A verifier that accepts a
   * `jku` on a different origin lets one allowlisted origin impersonate another.
   */
  it("pins jku to the issuer's own JWKS", async () => {
    const header = decodeProtectedHeader(await signCallerToken(options));

    expect(header.alg).toBe(A2A_JWS_ALG);
    expect(header.kid).toBe(TEST_AGENT_PRIVATE_JWK.kid);
    expect(header.jku).toBe(jwksUrl(AGENT_ORIGIN));
  });

  /**
   * `jose` compares `aud` byte-for-byte against what the far side derives from
   * `new URL(request.url).origin`, so a trailing slash or a stray path is a 401
   * on every request with nothing to catch it.
   */
  it("normalizes the audience to a bare origin", async () => {
    for (const audience of [
      "https://proxy.example.com",
      "https://proxy.example.com/",
      "https://proxy.example.com/v1/messages?x=1"
    ]) {
      const claims = decodeJwt(await signCallerToken({ ...options, audience }));
      expect(claims.aud).toBe("https://proxy.example.com");
    }
  });

  /**
   * `iss` and `jku` must name the same origin: a verifier compares `iss`
   * byte-for-byte against a normalized allowlist, so an un-normalized issuer
   * signs a token that is guaranteed to be rejected.
   */
  it("normalizes the issuer, and keeps it in step with jku", async () => {
    for (const issuer of [
      "https://agent.example",
      "https://agent.example/",
      "https://agent.example/mounted/here"
    ]) {
      const token = await signCallerToken({ ...options, issuer });
      expect(decodeJwt(token).iss).toBe("https://agent.example");
      expect(decodeProtectedHeader(token).jku).toBe(
        jwksUrl("https://agent.example")
      );
    }
  });

  it("refuses an issuer that is not an absolute URL", async () => {
    await expect(
      signCallerToken({ ...options, issuer: "agent.example" })
    ).rejects.toThrow();
  });

  it("refuses an audience that is not an absolute URL", async () => {
    await expect(
      signCallerToken({ ...options, audience: "proxy.example.com" })
    ).rejects.toThrow();
  });

  it("expires by default, and honours an explicit ttl", async () => {
    const now = Math.floor(Date.now() / 1000);
    const dflt = decodeJwt(await signCallerToken(options));
    expect(dflt.exp).toBeGreaterThan(now);
    expect(dflt.exp).toBeLessThanOrEqual(now + 121);

    const short = decodeJwt(
      await signCallerToken({ ...options, ttlSeconds: 5 })
    );
    expect(short.exp).toBeLessThanOrEqual(now + 6);
  });

  /**
   * The cache is keyed on the raw secret, so a rotated key must produce a token
   * signed by the new one rather than the entry left over from the old.
   */
  it("does not serve a rotated key from cache", async () => {
    const rotated = { ...TEST_AGENT_PRIVATE_JWK, kid: "rotated-kid" };
    await signCallerToken(options);
    const header = decodeProtectedHeader(
      await signCallerToken({
        ...options,
        signingKey: JSON.stringify(rotated)
      })
    );
    expect(header.kid).toBe("rotated-kid");
  });
});
