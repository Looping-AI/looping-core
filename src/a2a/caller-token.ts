import { importJWK, SignJWT, type JWK } from "jose";
import {
  A2A_JWS_ALG,
  IDENTITY_CLAIM,
  TENANT_CLAIM,
  jwksUrl
} from "@loopingai/a2a-protocol";
import { parsePrivateJwk } from "./card.js";

/** Default lifetime: long enough for clock skew, short enough to be worthless from a log. */
const DEFAULT_TTL_SECONDS = 120;

export interface CallerTokenOptions {
  /** This agent's raw private JWK JSON — the same `A2A_SIGNING_KEY` its card is signed with. */
  signingKey: string;
  /**
   * This agent's own origin. It becomes `iss`, and `jku` is derived from it, and
   * the two must agree: a verifier that accepts a `jku` on a different origin
   * than `iss` lets one allowlisted origin impersonate another.
   */
  issuer: string;
  /**
   * Who the token is for. Normalized to a bare origin, because a verifier
   * typically derives what it expects from `new URL(request.url).origin` and
   * `jose` compares `aud` byte-for-byte — a trailing slash or a stray path is a
   * 401 on every request with nothing to catch it. Throws on a value that is not
   * an absolute URL, which is the right moment for that to fail.
   */
  audience: string;
  /** The identity this agent asserts. */
  identity: Record<string, unknown>;
  /** Which tenant of this deployment the token speaks for. */
  tenant: string;
  /** Lifetime in seconds. Defaults to 120. */
  ttlSeconds?: number;
}

type SigningKey = Awaited<ReturnType<typeof importJWK>>;

/**
 * `importJWK` does real work and this is on the per-request path.
 *
 * Keyed by the raw secret so a rotated key invalidates the entry rather than
 * being ignored for the life of the isolate.
 */
let cached: { raw: string; key: SigningKey; kid: string } | undefined;

async function signingKeyFor(
  raw: string
): Promise<{ key: SigningKey; kid: string }> {
  if (cached?.raw === raw) return cached;
  const jwk: JWK & { kid: string } = parsePrivateJwk(raw);
  // Not cast to `CryptoKey`: `importJWK` returns a union, and asserting the
  // branch would be a lie the day this key is anything but Ed25519.
  const key = await importJWK(jwk, A2A_JWS_ALG);
  cached = { raw, key, kid: jwk.kid };
  return cached;
}

/**
 * Sign a short-lived token identifying **this agent as a caller** to another
 * service that trusts its card key.
 *
 * The production sibling of `makeGatewayToken`, which core previously shipped
 * only from `/testing` — so an agent that had to call out mint-signed had to
 * hand-write this shape, and every deployment that did so wrote its own subtly
 * different version of the `iss`/`jku` agreement above.
 *
 * Distinct from {@link signCallbackJwt}, which carries **no** claims: that one
 * proves "the agent you called is calling you back about this task", where this
 * proves "this is who I am and which tenant I speak for".
 */
export async function signCallerToken(
  options: CallerTokenOptions
): Promise<string> {
  const { key, kid } = await signingKeyFor(options.signingKey);
  return new SignJWT({
    [IDENTITY_CLAIM]: options.identity,
    [TENANT_CLAIM]: options.tenant
  })
    .setProtectedHeader({
      alg: A2A_JWS_ALG,
      kid,
      // Where the far side fetches the public half. A verifier must check this
      // origin against its own allowlist *before* fetching, which is what stops
      // a forged token nominating an attacker-controlled JWKS.
      jku: jwksUrl(options.issuer)
    })
    .setIssuer(options.issuer)
    .setAudience(new URL(options.audience).origin)
    .setIssuedAt()
    .setExpirationTime(`${options.ttlSeconds ?? DEFAULT_TTL_SECONDS}s`)
    .sign(key);
}
