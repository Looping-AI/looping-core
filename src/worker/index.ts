import { AGENT_CARD_PATH, SendMessageRequest } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  validateVersion
} from "@a2a-js/sdk/server";
import { RequestMalformedError, toJsonRpcError } from "@a2a-js/sdk/errors";
import {
  A2A_RPC_PATH,
  buildBaseCard,
  parsePrivateJwk,
  publicCardJwks,
  signCard,
  type AgentManifest
} from "../a2a/card.js";
import { buildCallContext, extensionHeaders } from "../a2a/context.js";
import {
  GatewayAuthError,
  bearerToken,
  verifyGatewayToken,
  type GatewayIdentity
} from "../a2a/verify.js";
import { A2AExecutor, type TurnStarter } from "../a2a/executor.js";
import { DurableTaskStore } from "../a2a/task-store.js";
import type { AgentResolver } from "../a2a/agent-stub.js";
import { parseGatewayOrigins, type A2ASecretsEnv } from "../env.js";

/**
 * The A2A Worker: the zero-trust, no-shared-secrets edge every Looping agent
 * puts in front of its Durable Object.
 *
 * Three routes, in order:
 *
 *  1. The card-signing **public** JWKS at the card's `jku`.
 *  2. A **signed** AgentCard at `…/.well-known/agent-card.json`, so a gateway can
 *     verify and pin this agent's identity at registration ("G knows R").
 *  3. **Verify the gateway's identity JWT** on every JSON-RPC call against the
 *     gateway's public JWKS ("R knows G"), then run the A2A JSON-RPC server for
 *     that call. {@link A2AExecutor} dispatches into the caller's agent DO — one
 *     instance per calling gateway-agent, keyed by the verified `identity.key`.
 *
 * No secret is ever shared in either direction: trust flows entirely on domains
 * and asymmetric (Ed25519) signatures over public JWKS.
 *
 * **Several agents may share one Worker.** The JSON-RPC and JWKS paths are
 * options (`rpcPath`, `jwksPath`) and both are matched exactly, so a consumer
 * mounts one handler per prefix behind its own router and each agent gets its
 * own card, JWKS and Durable Object.
 *
 * The card route is the exception: it is matched by **suffix**
 * (`…/.well-known/agent-card.json`), because that path is fixed by the A2A spec
 * and a mounted agent serves it under its own prefix. A handler will therefore
 * answer a card request on any prefix routed to it — which is correct when the
 * outer router only sends it its own, and is the one place where mounting relies
 * on that router rather than on this handler.
 *
 * Two options exist for the multi-agent case and only that case: `secrets`, so
 * each mount signs with its own key, and `audience`, so a token minted for one
 * mount does not verify at another. With one agent per Worker both defaults are
 * correct and neither should be set — and `audience` in particular must not be
 * set before the calling gateway mints a matching value.
 */

/** Default path serving the card-signing public JWKS (the card's `jku`). */
export const JWKS_PATH = "/.well-known/jwks.json";

/** The JSON-RPC method carrying a turn (v1.0 renamed v0.3's `message/send`). */
const SEND_MESSAGE_METHOD = "SendMessage";

/** The two secrets a mount signs and verifies with, already read off `env`. */
export interface A2ASecrets {
  /** Ed25519 private JWK, as JSON. See {@link A2ASecretsEnv.A2A_SIGNING_KEY}. */
  signingKey: string;
  /** Origin allowlist. See {@link A2ASecretsEnv.GATEWAY_ORIGINS}. */
  gatewayOrigins: string;
}

export interface A2AWorkerOptions<TEnv = A2ASecretsEnv> {
  /** The transport-independent half of this agent's card. */
  manifest: AgentManifest;
  /** Resolve the agent DO stub for a verified caller. */
  resolveAgent: AgentResolver;
  /** Start the durable turn. Must be idempotent — see {@link TurnStarter}. */
  startTurn: TurnStarter;
  /** Path serving the public JWKS. Defaults to {@link JWKS_PATH}. */
  jwksPath?: string;
  /** Path this agent answers JSON-RPC on. Defaults to `/a2a`. */
  rpcPath?: string;
  /**
   * Where to read this mount's two secrets. Defaults to the documented names,
   * `env.A2A_SIGNING_KEY` and `env.GATEWAY_ORIGINS`.
   *
   * Exists for the one case the defaults cannot serve: **several agents mounted
   * in one Worker**, each with its own signing identity. They share an `env`, so
   * they cannot all read `A2A_SIGNING_KEY`.
   *
   * ```ts
   * secrets: (env) => ({
   *   signingKey: env.A2A_SIGNING_KEY_PROACTIVE,
   *   gatewayOrigins: env.GATEWAY_ORIGINS
   * })
   * ```
   *
   * Renaming does not weaken anything: the same key is still Ed25519, still
   * signs the card and every callback JWT, and its public half is still what the
   * gateway pins. Only where it is read from changes.
   */
  secrets?: (env: TEnv) => A2ASecrets;
  /**
   * The audience a gateway JWT must carry. Defaults to the request origin.
   *
   * **Do not set this without changing your gateway first.** It is one half of a
   * two-sided contract: whatever is required here has to be exactly what the
   * calling gateway *mints*, and a mismatch is a 401 on every single request.
   * looping-gateway currently mints `new URL(agent.a2aEndpoint).origin` — scheme
   * and host, no path — so the default is the only value that authenticates
   * against it today. Overriding it to a per-agent value ahead of a matching
   * gateway change rejects all traffic, which is why this is opt-in rather than
   * something the mounted examples turn on.
   *
   * What it is *for*: several agents behind one origin. The origin then stops
   * identifying which agent a caller was authorized to reach. Nothing leaks
   * without it — each Durable Object is keyed by the verified `identity.key`, so
   * callers remain isolated regardless — but "which agent was this token for"
   * stops being a question anything asks, and this is where it would be asked.
   *
   * ```ts
   * // Only once the gateway mints this same string for this agent:
   * audience: (url) => `${url.origin}/proactive`
   * ```
   */
  audience?: string | ((url: URL) => string);
  /**
   * Advertise `securitySchemes` on the card. **Defaults to `false`** — see
   * `BuildCardOptions.advertiseSecuritySchemes` for why, and read that note
   * before turning it on.
   */
  advertiseSecuritySchemes?: boolean;
  /** Claim carrying the caller identity. Defaults to the Looping namespace. */
  identityClaim?: string;
  /**
   * Require a `taskPushNotificationConfig` on every `SendMessage`.
   *
   * Defaults to `true`, which is the accept-and-notify contract: the agent
   * accepts synchronously and delivers out of band, so a send with nowhere to
   * call back is a request that can never be answered. Set `false` only for an
   * agent that replies inline.
   */
  requirePushConfig?: boolean;
}

function unauthorized(reason: string): Response {
  return new Response(`unauthorized: ${reason}`, {
    status: 401,
    headers: { "www-authenticate": 'Bearer error="invalid_token"' }
  });
}

/**
 * A JSON-RPC error envelope for a failure raised before the SDK handler ran,
 * echoing the request's `id` so a conformant client can correlate it. Errors are
 * transported at HTTP 200 per JSON-RPC 2.0, matching what the SDK handler
 * returns for the failures it maps itself.
 *
 * Takes an already-mapped `error` because the mapper has to match the error's
 * origin: `@a2a-js/sdk/errors` and `@a2a-js/sdk/server` are separately bundled
 * entry points that each carry their own copy of the error hierarchy, so a
 * mapper only recognizes errors its own bundle constructed — the other one fails
 * its `instanceof` check and flattens every semantic error to a generic internal
 * error. Each call site below picks accordingly.
 */
function jsonRpcErrorResponse(
  body: unknown,
  error: { code: number; message: string }
): Response {
  const id = (body as { id?: string | number | null } | null)?.id ?? null;
  return Response.json({ jsonrpc: "2.0", id, error });
}

/**
 * Why a `SendMessage` fails the async-only contract, or `undefined` when it
 * holds. (Other methods carry no config and are always fine.)
 *
 * Checked here, before the SDK handler, rather than in the executor: an executor
 * throw is turned into a `failed` task, which a client reads as an accepted turn
 * that never calls back. A rejected send has to surface as a JSON-RPC error.
 */
function pushConfigError(rpcBody: {
  method?: string;
  params?: unknown;
}): string | undefined {
  if (rpcBody.method !== SEND_MESSAGE_METHOD) return undefined;

  // Decode through the generated codec rather than reading the raw body: the
  // wire form is protobuf-JSON, so this is what normalizes field naming and
  // oneof shapes into the typed request the SDK handler will also see.
  let params: SendMessageRequest;
  try {
    params = SendMessageRequest.fromJSON(rpcBody.params);
  } catch (err) {
    return `params are not a valid SendMessageRequest: ${(err as Error).message}`;
  }

  const pushConfig = params.configuration?.taskPushNotificationConfig;
  if (!pushConfig?.url) {
    return (
      "configuration.taskPushNotificationConfig.url is required: this agent " +
      "replies asynchronously via push notification (A2A §13.2)"
    );
  }
  if (!pushConfig.token) {
    return (
      "configuration.taskPushNotificationConfig.token is required: the gateway " +
      "uses it to correlate the callback to the pending task (A2A §13.2)"
    );
  }
  try {
    new URL(pushConfig.url);
  } catch {
    return `configuration.taskPushNotificationConfig.url is not a valid URL: ${pushConfig.url}`;
  }
  return undefined;
}

/**
 * Build the Worker `fetch` handler.
 *
 * ```ts
 * const handler = createA2AWorker({ manifest, resolveAgent: getAgent, startTurn });
 * export default { fetch: handler } satisfies ExportedHandler<Env>;
 * ```
 *
 * Two overloads, because `secrets` is optional for exactly one shape of `env`.
 * An `env` carrying the two documented names needs no reader; anything else has
 * to say where its keys live, and the type system is where that gets enforced —
 * the alternative is a `parsePrivateJwk` failure on the first request, which is
 * both later and much harder to read.
 */
// An `env` with the documented names: the default reader works, `secrets` is optional.
export function createA2AWorker<TEnv extends A2ASecretsEnv>(
  options: A2AWorkerOptions<TEnv>
): (request: Request, env: TEnv) => Promise<Response>;
// Anything else — a renamed or per-agent key — must supply the reader.
export function createA2AWorker<TEnv extends object>(
  options: A2AWorkerOptions<TEnv> & {
    secrets: (env: TEnv) => A2ASecrets;
  }
): (request: Request, env: TEnv) => Promise<Response>;
export function createA2AWorker<TEnv extends object>(
  options: A2AWorkerOptions<TEnv>
): (request: Request, env: TEnv) => Promise<Response> {
  const jwksPath = options.jwksPath ?? JWKS_PATH;
  const rpcPath = options.rpcPath ?? A2A_RPC_PATH;
  const requirePushConfig = options.requirePushConfig ?? true;
  // Only reachable through the first overload, which has already established
  // that `TEnv` carries the two documented names.
  const readSecrets =
    options.secrets ??
    ((env: TEnv): A2ASecrets => ({
      signingKey: (env as A2ASecretsEnv).A2A_SIGNING_KEY,
      gatewayOrigins: (env as A2ASecretsEnv).GATEWAY_ORIGINS
    }));

  return async function fetch(request: Request, env: TEnv): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    const secrets = readSecrets(env);
    const audience =
      typeof options.audience === "function"
        ? options.audience(url)
        : (options.audience ?? origin);
    const privateJwk = parsePrivateJwk(secrets.signingKey);
    const cardOptions = {
      origin,
      rpcPath: options.rpcPath,
      advertiseSecuritySchemes: options.advertiseSecuritySchemes
    };

    // (1) Card-signing public JWKS — resolves the card's `jku` for the gateway.
    if (request.method === "GET" && url.pathname === jwksPath) {
      return Response.json(publicCardJwks(privateJwk), {
        headers: { "cache-control": "public, max-age=3600" }
      });
    }

    // (2) Signed AgentCard discovery. `signCard` returns the protobuf-JSON
    // encoding — the exact document the signature is computed over.
    if (request.method === "GET" && url.pathname.endsWith(AGENT_CARD_PATH)) {
      const card = await signCard(
        buildBaseCard(options.manifest, cardOptions),
        { privateJwk, jku: `${origin}${jwksPath}` }
      );
      return Response.json(card);
    }

    // (3) A2A JSON-RPC — gateway-authenticated, dispatched into the caller's DO.
    //
    // Matched on `rpcPath`, not on the method alone. Accepting every POST made
    // the path this agent advertises purely decorative: a call to any URL on the
    // origin was served as JSON-RPC, so a mounted agent's isolation rested
    // entirely on an outer router matching first, and a typo'd endpoint quietly
    // worked instead of 404ing.
    if (request.method === "POST" && url.pathname === rpcPath) {
      const token = bearerToken(request);
      if (!token) return unauthorized("missing gateway bearer token");

      let identity: GatewayIdentity;
      try {
        ({ identity } = await verifyGatewayToken(token, {
          allowedOrigins: parseGatewayOrigins(secrets.gatewayOrigins),
          audience,
          identityClaim: options.identityClaim
        }));
      } catch (err) {
        const message =
          err instanceof GatewayAuthError ? err.message : "verification failed";
        return unauthorized(message);
      }

      // The DO instance is keyed by the verified `identity.key`; without it the
      // executor cannot route the call — refuse rather than fall back to a
      // shared instance. Guaranteed non-null past this point.
      if (!identity.key) {
        return new Response("bad request: gateway identity missing key", {
          status: 400
        });
      }

      const body = await request.json<string | Record<string, unknown>>();
      // `typeof null === "object"`, so the null check is load-bearing: a body of
      // literal `null` is valid JSON and would otherwise make `rpcBody` null,
      // throwing on the property reads below instead of reaching the SDK
      // handler, which maps it to the same -32602 that `[]` or a string gets.
      const rpcBody = (
        typeof body === "object" && body !== null ? body : {}
      ) as { method?: string; params?: unknown };
      const card = buildBaseCard(options.manifest, cardOptions);
      const context = buildCallContext(request, identity);

      // v1.0 negotiates the protocol version per request via the `A2A-Version`
      // header, and the SDK leaves enforcement to the transport binding (its
      // Express handlers do it; this Worker is the equivalent seam). An absent
      // header is treated as `0.3` by the SDK, which a v1.0-only card does not
      // advertise — so a legacy caller is rejected here rather than silently
      // mis-served.
      try {
        validateVersion(context.requestedVersion, card, "JSONRPC");
      } catch (err) {
        // Thrown by the server bundle — map it with the server bundle's mapper.
        return jsonRpcErrorResponse(
          body,
          JsonRpcTransportHandler.mapToJSONRPCError(err)
        );
      }

      if (requirePushConfig) {
        const contractError = pushConfigError(rpcBody);
        if (contractError) {
          // Constructed from the errors bundle — map it with that bundle's.
          return jsonRpcErrorResponse(
            body,
            toJsonRpcError(new RequestMalformedError(contractError))
          );
        }
      }

      const handler = new DefaultRequestHandler(
        card,
        new DurableTaskStore(identity, options.resolveAgent),
        new A2AExecutor({
          identity,
          jku: `${origin}${jwksPath}`,
          resolveAgent: options.resolveAgent,
          startTurn: options.startTurn
        })
      );
      const rpc = new JsonRpcTransportHandler(handler);
      const result = await rpc.handle(body, context);

      // Streaming is not advertised; reject async generators outright.
      if (Symbol.asyncIterator in result) {
        return new Response("streaming not supported", { status: 501 });
      }
      return Response.json(result, { headers: extensionHeaders(context) });
    }

    return new Response("not found", { status: 404 });
  };
}
