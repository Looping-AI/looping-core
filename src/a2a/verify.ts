import {
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload
} from "jose";

/**
 * Verify the gateway identity JWT (the "B authenticates A" half of zero-trust).
 *
 * The gateway signs a short-lived EdDSA JWT and sends it as a Bearer token on
 * every A2A call. Per RFC 7515 §4.1.2 it embeds a `jku` header pointing at its
 * public JWKS, so remote agents don't need a separately configured JWKS URL —
 * they read `jku` straight from the token and verify the key from there.
 *
 * Security: the `jku` origin is validated against the allowed origins before
 * fetching, preventing key-injection attacks (an attacker cannot point `jku` at
 * their own JWKS and have it accepted).
 *
 * **This file is a guardian.** The four checks below — `jku` present → origin
 * allowlist → `iss` origin equals `jku` origin → `jwtVerify` pinned to EdDSA —
 * are the whole zero-trust contract, and they arrived here byte-identical from
 * two independently-evolved agents. Do not weaken any of them, do not make any
 * of them optional, and do not add a bypass for local development: run a local
 * gateway instead.
 */

/** Algorithm the gateway signs with — reject anything else. */
const ALG = "EdDSA";

/**
 * Default namespaced claim carrying the minimal caller identity.
 *
 * Overridable via {@link VerifyOptions.identityClaim} for a deployment that
 * isn't behind looping-gateway; the default is the Looping namespace so an
 * agent built on this package needs no configuration to interoperate.
 */
export const IDENTITY_CLAIM = "https://looping.ai/identity";

/**
 * The gateway-agent instance identity forwarded by the gateway — i.e. which
 * registered agent instance dispatched this call, not the human end user.
 * Mirrors `RemoteIdentity` in looping-gateway's `src/auth/agent-jwt.ts`.
 *
 * Any end user travels unverified, inline in the message text; the gateway
 * deliberately excludes it from this signed claim so a remote agent cannot read
 * the full caller auth context. Every field is optional because the claim is
 * whatever the issuer put there — {@link GatewayIdentity.key} is the only one
 * anything downstream depends on, and a caller without it is rejected before a
 * DO is ever addressed.
 */
export interface GatewayIdentity {
  /** Canonical instance key, e.g. `custom:7:analytics`. */
  key?: string;
  /** Registry name of the logical agent instance. */
  name?: string;
  /** Dispatch kind of the caller (`"custom"` for remote agents). */
  kind?: string;
  /** Workspace the calling agent instance belongs to. */
  workspaceId?: number | null;
}

/** Thrown when a gateway token is missing or fails verification. */
export class GatewayAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayAuthError";
  }
}

// jose's remote JWKS helper caches keys + handles rotation; build one per URL
// and reuse it across requests in the same isolate.
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksByUrl.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    jwksByUrl.set(url, set);
  }
  return set;
}

/** Extract the Bearer token from an `Authorization` header, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export interface VerifyOptions {
  /** Allowed gateway origins — validates both the `jku` domain and `iss` claim. */
  allowedOrigins: string[];
  audience: string;
  /** Claim carrying the caller identity. Defaults to {@link IDENTITY_CLAIM}. */
  identityClaim?: string;
}

/**
 * Normalize configured gateway origins to the HTTPS origins emitted in gateway
 * JWT `jku` and `iss` claims. This accepts a hostname, `http://` URL, or URL
 * with a trailing slash while keeping the verification allowlist exact.
 */
export function normalizeGatewayOrigins(origins: string[]): string[] {
  return origins.map((origin) => {
    const trimmed = origin.trim();
    if (!trimmed) {
      throw new GatewayAuthError("allowed gateway origin cannot be empty");
    }
    try {
      return new URL(`https://${trimmed.replace(/^https?:\/\//i, "")}`).origin;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GatewayAuthError(
        `invalid allowed gateway origin '${origin}': ${message}`
      );
    }
  });
}

/**
 * Verify a gateway JWT and return its payload + parsed identity.
 *
 * The `jku` JWK Set URL is read directly from the token's protected header
 * (RFC 7515 §4.1.2) and validated against the allowlist before fetching, so no
 * separate JWKS URL configuration is needed on the remote side.
 *
 * Throws {@link GatewayAuthError} on any failure.
 */
export async function verifyGatewayToken(
  token: string,
  opts: VerifyOptions
): Promise<{ payload: JWTPayload; identity: GatewayIdentity }> {
  try {
    const allowedOrigins = normalizeGatewayOrigins(opts.allowedOrigins);
    // Extract jku from the protected header — this is the standard way the
    // gateway advertises where to fetch its public key (RFC 7515 §4.1.2).
    const header = decodeProtectedHeader(token) as { jku?: string };
    const jku = header.jku;
    if (!jku) {
      throw new GatewayAuthError(
        "gateway JWT missing jku header (RFC 7515 §4.1.2)"
      );
    }
    // Security: validate the jku origin before fetching. Without this an
    // attacker could forge a token with jku pointing at their own JWKS.
    const jkuOrigin = new URL(jku).origin;
    if (!allowedOrigins.includes(jkuOrigin)) {
      throw new GatewayAuthError(
        `jku origin '${jkuOrigin}' is not in the allowed gateway origins`
      );
    }
    // Prevent one listed gateway from impersonating another: the origin where
    // keys are fetched must match the origin that issued the token.
    const rawIss = decodeJwt(token).iss ?? "";
    const issOrigin = new URL(rawIss).origin;
    if (issOrigin !== jkuOrigin) {
      throw new GatewayAuthError(
        `jku origin '${jkuOrigin}' does not match iss origin '${issOrigin}'`
      );
    }
    const { payload } = await jwtVerify(token, jwksFor(jku), {
      issuer: allowedOrigins,
      audience: opts.audience,
      algorithms: [ALG]
    });
    const claim = opts.identityClaim ?? IDENTITY_CLAIM;
    const identity = (payload[claim] as GatewayIdentity | undefined) ?? {};
    return { payload, identity };
  } catch (err) {
    if (err instanceof GatewayAuthError) throw err;
    throw new GatewayAuthError((err as Error).message);
  }
}
