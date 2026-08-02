import {
  A2A_VERSION_HEADER,
  Extensions,
  HTTP_EXTENSION_HEADER
} from "@a2a-js/sdk";
import {
  defaultServerCallContextBuilder,
  type RequestHeaders,
  type ServerCallContext,
  type User
} from "@a2a-js/sdk/server";
import type { GatewayIdentity } from "./verify.js";

/**
 * The per-call {@link ServerCallContext} bridge for a Workers `fetch` handler.
 *
 * v1.0 made the call context mandatory on every request-handler and task-store
 * method, and the SDK only ships Express and gRPC bindings that build one; this
 * is the equivalent seam for `fetch`.
 */

/**
 * The verified calling gateway-agent, as the SDK's {@link User}. `userName` is
 * the canonical instance key (e.g. `custom:7:analytics`) — the same value the
 * agent Durable Object is keyed by, so the SDK's owner-scoped bookkeeping lines
 * up with the isolation this Worker already enforces by routing.
 */
class GatewayUser implements User {
  constructor(private readonly identity: GatewayIdentity) {}

  get isAuthenticated(): boolean {
    return true;
  }

  get userName(): string {
    // The Worker rejects a keyless identity (400) before a context is built.
    return this.identity.key ?? "";
  }
}

/**
 * Build the call context for one verified JSON-RPC request. The default builder
 * stashes the raw headers in the context's state bag, so an executor can reach
 * them the same way it would under the Express binding.
 *
 * `tenant` names which agent on this origin the call is for. The SDK's
 * `JsonRpcTransportHandler` would also lift it off `params.tenant` on its own,
 * but only when the context arrives without one — so passing it here is not
 * redundant: this Worker has already parsed, authorized and routed on the
 * tenant before a handler exists to receive the context, and setting it keeps
 * the value the executor and task store see identical to the one that chose
 * them. It is also what reaches the extended-card provider, which the SDK calls
 * with the context alone.
 */
export function buildCallContext(
  request: Request,
  identity: GatewayIdentity,
  tenant: string
): ServerCallContext {
  const headers: RequestHeaders = {};
  for (const [name, value] of request.headers) headers[name] = value;

  return defaultServerCallContextBuilder({
    extensions: Extensions.parseServiceParameter(
      request.headers.get(HTTP_EXTENSION_HEADER) ?? undefined
    ),
    user: new GatewayUser(identity),
    headers,
    requestedVersion: request.headers.get(A2A_VERSION_HEADER) ?? undefined,
    tenant
  });
}

/** Echo back the extensions the handler actually activated (spec §14.2.2). */
export function extensionHeaders(context: ServerCallContext): HeadersInit {
  const activated = context.activatedExtensions;
  if (!activated?.length) return {};
  return { [HTTP_EXTENSION_HEADER]: Extensions.toServiceParameter(activated) };
}
