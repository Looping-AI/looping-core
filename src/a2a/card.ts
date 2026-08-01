import type { JWK } from "jose";
import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  generateAgentCardSignature
} from "@a2a-js/sdk";

/** JWS algorithm for the card signature — must match the gateway (`EdDSA`). */
const ALG = "EdDSA";

/** The default JSON-RPC path an agent answers on (the card's only interface). */
export const A2A_RPC_PATH = "/a2a";

/**
 * The transport-independent half of an {@link AgentCard} — everything that does
 * not depend on the request origin. {@link buildBaseCard} adds
 * `supportedInterfaces` and the security fields.
 *
 * Derived from the SDK `AgentCard` rather than hand-declared so a protocol field
 * that gains a requirement fails the build here instead of silently going
 * unadvertised.
 */
export type AgentManifest = Pick<
  AgentCard,
  | "name"
  | "description"
  | "version"
  | "capabilities"
  | "defaultInputModes"
  | "defaultOutputModes"
  | "skills"
>;

/**
 * An AgentCard in its **protobuf-JSON** encoding — the form served at the
 * well-known path and the exact document a signature is computed over. Distinct
 * from the in-memory `AgentCard`: the wire form omits proto defaults and renders
 * oneofs (`securitySchemes`, `Part.content`) as a single key rather than a
 * `$case` tag.
 */
export type WireAgentCard = Record<string, unknown>;

export interface CardSigningConfig {
  /** Ed25519 private JWK (with `kid`) that signs the card. */
  privateJwk: JWK & { kid: string };
  /** Public URL serving this agent's JWKS — embedded as the JWS `jku`. */
  jku: string;
}

export interface BuildCardOptions {
  /** Origin the card is served from; the interface `url` is built under it. */
  origin: string;
  /** Path this agent answers JSON-RPC on. Defaults to {@link A2A_RPC_PATH}. */
  rpcPath?: string;
  /**
   * Advertise the gateway's Bearer-JWT scheme in `securitySchemes`.
   *
   * **Defaults to `false`, and the default is load-bearing.** `SecurityScheme`
   * is the card's only protobuf *oneof*, and `SecurityScheme.fromJSON` reads
   * only the wire spelling (`{ httpAuthSecurityScheme: … }`), not the decoded
   * `$case` form. A verifier that decodes the fetched card and then canonicalizes
   * it through `toJSON(fromJSON(card))` therefore decodes twice, and the second
   * pass collapses `{ gatewayJwt: { httpAuthSecurityScheme: … } }` to
   * `{ gatewayJwt: {} }` — a different document from the one that was signed, so
   * **the signature fails**. looping-gateway's `canonicalCardPayload` does
   * exactly this today.
   *
   * With schemes omitted, the served document is a fixed point under repeated
   * decoding and the signature covers all of it however many times a verifier
   * normalizes. `securityRequirements` is unaffected either way — it is a plain
   * map, not a oneof — so the card still declares that auth is *required*, it
   * just doesn't describe the scheme.
   *
   * Turn this on once the verifier stops double-decoding (for looping-gateway:
   * drop the redundant `fromJSON` in `canonicalCardPayload`, which already
   * receives a typed `AgentCard`). `card.spec.ts` pins both behaviors, so the
   * day the SDK makes `fromJSON` idempotent that test will tell you.
   */
  advertiseSecuritySchemes?: boolean;
}

/**
 * The `httpAuthSecurityScheme` describing the gateway's Bearer JWT, and the
 * requirement that references it. Split out so the requirement can be advertised
 * even when {@link BuildCardOptions.advertiseSecuritySchemes} keeps the scheme
 * itself off the wire.
 */
const GATEWAY_SCHEME_ID = "gatewayJwt";

/**
 * Build the (unsigned) AgentCard.
 *
 * v1.0 replaced the card's flat `url` / `preferredTransport` / `protocolVersion`
 * fields with an ordered `supportedInterfaces` list, where each entry pins its
 * own protocol binding *and* protocol version. That per-interface
 * `protocolVersion` is what a client's transport factory matches on and what the
 * Worker validates the `A2A-Version` request header against, so it must be the
 * real protocol version rather than the agent's own version string.
 */
export function buildBaseCard(
  manifest: AgentManifest,
  opts: BuildCardOptions
): AgentCard {
  const rpcPath = opts.rpcPath ?? A2A_RPC_PATH;
  return {
    ...manifest,
    supportedInterfaces: [
      {
        url: `${opts.origin}${rpcPath}`,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
        // Single-tenant agent: one DO per verified gateway identity, so the
        // protocol-level tenant slot goes unused.
        tenant: ""
      }
    ],
    provider: undefined,
    documentationUrl: undefined,
    iconUrl: undefined,
    securitySchemes: opts.advertiseSecuritySchemes
      ? {
          [GATEWAY_SCHEME_ID]: {
            scheme: {
              $case: "httpAuthSecurityScheme",
              value: { description: "", scheme: "bearer", bearerFormat: "JWT" }
            }
          }
        }
      : {},
    // v0.3's `security: [{ gatewayJwt: [] }]`. The empty `list` means the scheme
    // is required but carries no scopes. Safe to advertise unconditionally: this
    // is a plain map, so it survives the round trip that eats `securitySchemes`.
    securityRequirements: [
      { schemes: { [GATEWAY_SCHEME_ID]: { list: [] } } }
    ],
    signatures: []
  };
}

/**
 * Sign the card with a detached-payload EdDSA flattened JWS, returning the
 * signed **wire** card to serve. v1.0 standardized this (A2A spec §8.4), so the
 * canonicalization and JWS construction are the SDK's rather than a local
 * scheme: a JCS (RFC 8785) canonicalization of the card with `signatures`
 * removed, under a protected header carrying `alg`, `kid` and `typ` (all three
 * are required — the SDK verifier rejects a signature missing any of them).
 *
 * The card is normalized to its wire form *before* signing because that is what
 * the verifier canonicalizes: `verifyAgentCardSignature` re-encodes whatever
 * document it fetched through `AgentCard.toJSON(AgentCard.fromJSON(card))`.
 * Signing the in-memory proto object instead would canonicalize `$case` tags and
 * proto defaults that never appear on the wire, and every signature would fail.
 *
 * A verifying gateway strips the `signatures` array, recomputes the canonical
 * payload, and verifies — pinning this key's `kid`+`jku` on first registration
 * (Trust-On-First-Use).
 */
export async function signCard(
  card: AgentCard,
  cfg: CardSigningConfig
): Promise<WireAgentCard> {
  const sign = generateAgentCardSignature(cfg.privateJwk, {
    alg: ALG,
    kid: cfg.privateJwk.kid,
    typ: "JOSE",
    jku: cfg.jku
  });
  const signed = await sign(wireCard(card));
  return signed as unknown as WireAgentCard;
}

/**
 * The card's protobuf-JSON encoding. Typed back as `AgentCard` for the SDK
 * signer, which is generic over "the document to canonicalize" rather than over
 * the in-memory shape specifically.
 *
 * Encode-only — never `toJSON(fromJSON(card))`. `fromJSON` reads the *wire*
 * spelling of a oneof, so running it over an in-memory card silently drops every
 * `$case`-tagged field. The verifier's round trip is the mirror image and stable:
 * it decodes the document it fetched and re-encodes it to exactly this.
 */
export function wireCard(card: AgentCard): AgentCard {
  return AgentCard.toJSON(card) as AgentCard;
}

/**
 * Parse and validate the `A2A_SIGNING_KEY` secret into the private JWK used to
 * sign the card. Throws if the JWK is missing its `kid` (required for the JWS
 * protected header and gateway key-pinning).
 */
export function parsePrivateJwk(raw: string): CardSigningConfig["privateJwk"] {
  const jwk = JSON.parse(raw) as { kid?: string };
  if (!jwk.kid) throw new Error("A2A_SIGNING_KEY must include a `kid`");
  return jwk as CardSigningConfig["privateJwk"];
}

/** Public card-signing JWKS (served at the `jku`): the private JWK minus `d`. */
export function publicCardJwks(privateJwk: JWK & { kid: string }): {
  keys: JWK[];
} {
  const { d: _d, ...pub } = privateJwk;
  void _d;
  return { keys: [{ ...pub, use: "sig", alg: ALG }] };
}
