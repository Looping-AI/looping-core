import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  AGENT_CARD_PATH,
  A2A_PROTOCOL_VERSION,
  AgentCard,
  verifyAgentCardSignature
} from "@a2a-js/sdk";
import { createA2AWorker, JWKS_PATH } from "./index.js";
import type { AgentManifest } from "../a2a/card.js";
import type { A2ASecretsEnv } from "../env.js";
import type { AgentResolver } from "../a2a/agent-stub.js";
import { makeGatewayToken, TEST_TENANT } from "../testing/auth.js";
import {
  AGENT_ORIGIN,
  GATEWAY_ORIGIN,
  TEST_AGENT_PRIVATE_JWK,
  gatewayPublicJwks
} from "../testing/fixtures.js";

/**
 * The Worker edge, route by route.
 *
 * Everything asserted here happens *before* a Durable Object is addressed, which
 * is the interesting half: an unauthenticated or malformed call must be refused
 * at the edge rather than becoming a `failed` task a client reads as an accepted
 * turn that never calls back.
 */

const manifest = (name: string): AgentManifest => ({
  name,
  description: "an agent behind the A2A edge",
  version: "0.1.0",
  capabilities: {
    streaming: false,
    pushNotifications: true,
    extensions: []
  },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: []
});

/** The stub card for the origin — describes the deployment, not an agent. */
const hostManifest = manifest("worker-spec-host");

const env: A2ASecretsEnv = {
  A2A_SIGNING_KEY: JSON.stringify(TEST_AGENT_PRIVATE_JWK),
  GATEWAY_ORIGINS: JSON.stringify([GATEWAY_ORIGIN])
};

/** Never reached by these specs — every one is refused before dispatch. */
const resolveAgent: AgentResolver = () => {
  throw new Error("resolveAgent must not be reached in these specs");
};

const tenantAgent = (name: string) => ({
  manifest: manifest(name),
  resolveAgent,
  startTurn: async () => {}
});

const worker = createA2AWorker({
  manifest: hostManifest,
  tenants: {
    [TEST_TENANT]: tenantAgent("worker-spec-agent"),
    sibling: tenantAgent("worker-spec-sibling")
  }
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${AGENT_ORIGIN}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });

/**
 * A `SendMessage` addressed at a tenant. Every request carries one: there is no
 * default agent, so an omitted tenant is a rejection rather than a fallback.
 */
const sendMessage = (params: object, tenant: string = TEST_TENANT) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "SendMessage",
  params: { tenant, ...params }
});

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `${GATEWAY_ORIGIN}/.well-known/jwks.json`) {
      return new Response(gatewayPublicJwks(), {
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  });
});

afterAll(() => vi.unstubAllGlobals());

describe("discovery routes", () => {
  it("serves the card-signing public JWKS, with no private component", async () => {
    const res = await worker(new Request(`${AGENT_ORIGIN}${JWKS_PATH}`), env);
    const body = await res.json<{ keys: Record<string, unknown>[] }>();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
    expect(body.keys[0].kid).toBe(TEST_AGENT_PRIVATE_JWK.kid);
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("serves the stub card at the well-known path, not any tenant's", async () => {
    // RFC 8615 reserves this URI per *authority*, so exactly one card is
    // discoverable here however many agents the origin serves. Serving a
    // tenant's card would make that tenant the one every gateway pinned.
    const res = await worker(
      new Request(`${AGENT_ORIGIN}/${AGENT_CARD_PATH}`),
      env
    );
    const card = await res.json<{
      name: string;
      capabilities: { extendedAgentCard: boolean };
      supportedInterfaces: { tenant: string }[];
    }>();

    expect(res.status).toBe(200);
    expect(card.name).toBe("worker-spec-host");
    // It names no tenant — a caller reaches a real agent by asking for one.
    expect(card.supportedInterfaces[0].tenant ?? "").toBe("");
    // …and advertises the route for doing so. The SDK refuses
    // `GetExtendedAgentCard` outright when this is unset (spec §3.3.4).
    expect(card.capabilities.extendedAgentCard).toBe(true);
  });

  it("signs the stub card with a jku pointing back at its own JWKS route", async () => {
    const res = await worker(
      new Request(`${AGENT_ORIGIN}/${AGENT_CARD_PATH}`),
      env
    );
    const card = await res.json<Record<string, unknown>>();

    expect(res.status).toBe(200);
    expect(Array.isArray(card.signatures)).toBe(true);

    const [sig] = card.signatures as { protected: string }[];
    const header = JSON.parse(
      atob(sig.protected.replace(/-/g, "+").replace(/_/g, "/"))
    );
    // A gateway resolves the card's key from this, so it has to be this agent's.
    expect(header.jku).toBe(`${AGENT_ORIGIN}${JWKS_PATH}`);
    expect(header.kid).toBe(TEST_AGENT_PRIVATE_JWK.kid);
    expect(header.alg).toBe("EdDSA");
  });

  it("advertises the interface at the origin the request arrived on", async () => {
    // The card is built per request, so one deployment serves a correct card on
    // whatever hostname is in front of it.
    const res = await worker(
      new Request(`https://elsewhere.test/${AGENT_CARD_PATH}`),
      env
    );
    const card = await res.json<{
      supportedInterfaces: { url: string; protocolVersion: string }[];
    }>();

    expect(card.supportedInterfaces[0].url).toBe("https://elsewhere.test/a2a");
    expect(card.supportedInterfaces[0].protocolVersion).toBe(
      A2A_PROTOCOL_VERSION
    );
  });

  it("404s an unknown route", async () => {
    const res = await worker(new Request(`${AGENT_ORIGIN}/nope`), env);
    expect(res.status).toBe(404);
  });

  it("404s a POST to a path that is not this agent's rpcPath", async () => {
    // The JSON-RPC branch matches the advertised path, not merely the method.
    // Accepting every POST made `rpcPath` decorative — a call to any URL on the
    // origin was served as JSON-RPC, so a mounted agent's isolation rested
    // entirely on an outer router matching first, and a typo'd endpoint quietly
    // worked instead of failing.
    const res = await worker(
      new Request(`${AGENT_ORIGIN}/not-the-rpc-path`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sendMessage({}))
      }),
      env
    );
    expect(res.status).toBe(404);
  });
});

describe("gateway authentication", () => {
  it("refuses a call with no bearer token", async () => {
    const res = await worker(post(sendMessage({})), env);

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("refuses a token from an origin outside GATEWAY_ORIGINS", async () => {
    const token = await makeGatewayToken();
    const res = await worker(
      post(sendMessage({}), { authorization: `Bearer ${token}` }),
      { ...env, GATEWAY_ORIGINS: JSON.stringify(["https://other.test"]) }
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/not in the allowed gateway origins/);
  });

  it("refuses a verified token that carries no identity key", async () => {
    // Without it the executor cannot route to a DO instance. Refusing beats
    // falling back to a shared instance, which would cross callers' tasks.
    const token = await makeGatewayToken({ identity: { name: "anonymous" } });
    const res = await worker(
      post(sendMessage({}), { authorization: `Bearer ${token}` }),
      env
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/identity missing key/);
  });
});

/**
 * Several agents on one origin, addressed by `tenant`.
 *
 * They share an endpoint, so they share an `aud` — the audience proves a token
 * was minted for this *deployment* and can say nothing about which agent on it.
 * Everything below is about the claim that can.
 */
describe("tenant routing", () => {
  const call = (body: unknown, token: string): Promise<Response> =>
    worker(post(body, { authorization: `Bearer ${token}` }), env);

  it("refuses a request that names no tenant", async () => {
    // No default agent: picking one would mean serving a caller an agent it
    // never asked for.
    const token = await makeGatewayToken();
    const res = await call(
      { jsonrpc: "2.0", id: 7, method: "SendMessage", params: {} },
      token
    );
    const body = await res.json<{ error: { message: string } }>();

    expect(body.error.message).toMatch(/params\.tenant is required/);
    // The error has to say how to recover, since the stub card cannot list them.
    expect(body.error.message).toMatch(/GetExtendedAgentCard/);
  });

  it("refuses a tenant no agent is registered under", async () => {
    const token = await makeGatewayToken({ tenant: "ghost" });
    const res = await call(sendMessage({}, "ghost"), token);
    const body = await res.json<{ error: { message: string } }>();

    expect(body.error.message).toMatch(/unknown tenant 'ghost'/);
  });

  it("refuses a token minted for a sibling tenant", async () => {
    // The replay this design has to stop. The token is entirely valid — right
    // gateway, right signature, right audience, and the audience *cannot*
    // distinguish siblings because they share one endpoint. Only the tenant
    // claim separates them, so if this ever returns anything but 401, one agent
    // can spend another's token by editing a field in the request body.
    const token = await makeGatewayToken({ tenant: "sibling" });
    const res = await call(sendMessage({}, TEST_TENANT), token);

    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/authorizes tenant 'sibling'/);
  });

  it("refuses a token carrying no tenant claim at all", async () => {
    // A gateway too old to scope its tokens. Treating an absent claim as a
    // wildcard would silently reopen the replay above for every such caller.
    const token = await makeGatewayToken({ tenant: "" });
    const res = await call(sendMessage({}, TEST_TENANT), token);

    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/authorizes tenant '<none>'/);
  });

  it("accepts a token whose tenant matches the one addressed", async () => {
    const token = await makeGatewayToken({ identity: { name: "anonymous" } });
    const res = await call(sendMessage({}, TEST_TENANT), token);

    // 400, not 401: the token verified and the tenant matched, so the call died
    // one step later on the keyless identity. Anything 401 would mean the
    // tenant check rejected a legitimate call.
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/identity missing key/);
  });
});

describe("GetExtendedAgentCard", () => {
  const getCard = async (tenant: string, tokenTenant = tenant) => {
    const token = await makeGatewayToken({ tenant: tokenTenant });
    return worker(
      post(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "GetExtendedAgentCard",
          params: { tenant }
        },
        {
          authorization: `Bearer ${token}`,
          "A2A-Version": A2A_PROTOCOL_VERSION
        }
      ),
      env
    );
  };

  it("returns the addressed tenant's own signed card", async () => {
    // The only way to get a tenant's card, since the well-known path serves the
    // stub. A gateway registering an agent pins the key from exactly this.
    const res = await getCard(TEST_TENANT);
    const body = await res.json<{
      result: {
        name: string;
        supportedInterfaces: { tenant: string; url: string }[];
        signatures: { protected: string }[];
      };
    }>();

    expect(body.result.name).toBe("worker-spec-agent");
    expect(body.result.supportedInterfaces[0].tenant).toBe(TEST_TENANT);
    // Every tenant answers on the one endpoint — that is what tenant is for.
    expect(body.result.supportedInterfaces[0].url).toBe(`${AGENT_ORIGIN}/a2a`);

    const header = JSON.parse(
      atob(
        body.result.signatures[0].protected
          .replace(/-/g, "+")
          .replace(/_/g, "/")
      )
    );
    expect(header.jku).toBe(`${AGENT_ORIGIN}${JWKS_PATH}`);
  });

  it("distinguishes tenants", async () => {
    const res = await getCard("sibling");
    const body = await res.json<{ result: { name: string } }>();
    expect(body.result.name).toBe("worker-spec-sibling");
  });

  it("survives the SDK re-encoding the card it returns", async () => {
    // The transport runs `AgentCard.toJSON()` over whatever the provider
    // returns, so returning an already-encoded wire card would encode twice.
    //
    // `advertiseSecuritySchemes` is on here deliberately, and this spec is
    // close to worthless without it: `securitySchemes` is the card's only
    // protobuf *oneof*, and the second encode is what collapses
    // `{ gatewayJwt: { httpAuthSecurityScheme: … } }` to `{ gatewayJwt: {} }`.
    // With schemes off — the default — encoding twice is a no-op and this
    // passes against the broken implementation too.
    const advertising = createA2AWorker({
      manifest: hostManifest,
      tenants: { [TEST_TENANT]: tenantAgent("worker-spec-agent") },
      advertiseSecuritySchemes: true
    });

    const res = await advertising(
      post(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "GetExtendedAgentCard",
          params: { tenant: TEST_TENANT }
        },
        {
          authorization: `Bearer ${await makeGatewayToken()}`,
          "A2A-Version": A2A_PROTOCOL_VERSION
        }
      ),
      env
    );
    const { result } = await res.json<{ result: Record<string, unknown> }>();

    // The scheme survived the round trip at all — if this collapsed, the
    // signature check below would fail for a reason worth naming separately.
    expect(result.securitySchemes).toMatchObject({
      gatewayJwt: { httpAuthSecurityScheme: { scheme: "bearer" } }
    });

    // Verified exactly as looping-gateway does: decode what arrived, re-encode,
    // check the detached JWS. Rejects if the served document is not the one
    // that was signed.
    const { d: _d, ...publicJwk } = TEST_AGENT_PRIVATE_JWK;
    void _d;
    const verify = verifyAgentCardSignature(async () => publicJwk);
    await expect(
      verify(AgentCard.toJSON(AgentCard.fromJSON(result)) as AgentCard)
    ).resolves.not.toThrow();
  });

  it("is refused when the token names a different tenant", async () => {
    // Fetching a card is authorized the same way sending a message is; a
    // caller cannot enumerate its siblings' cards with its own token.
    const res = await getCard("sibling", TEST_TENANT);
    expect(res.status).toBe(401);
  });
});

describe("the accept-and-notify contract", () => {
  const authed = async (params: object) =>
    worker(
      post(sendMessage(params), {
        authorization: `Bearer ${await makeGatewayToken()}`,
        "A2A-Version": A2A_PROTOCOL_VERSION
      }),
      env
    );

  const message = {
    messageId: "m1",
    role: "ROLE_USER",
    parts: [{ text: "hello" }]
  };

  it("rejects a send with no push-notification config as a JSON-RPC error", async () => {
    // Deliberately a JSON-RPC error and not a failed task: a failed task reads
    // to a client as an accepted turn that will never call back.
    const res = await authed({ request: { message } });
    const body = await res.json<{ id: number; error: { message: string } }>();

    expect(res.status).toBe(200);
    expect(body.id).toBe(7);
    expect(body.error.message).toMatch(/taskPushNotificationConfig\.url/);
  });

  it("rejects a push config with a url but no correlation token", async () => {
    const res = await authed({
      request: { message },
      configuration: {
        taskPushNotificationConfig: { url: "https://gateway.test/cb" }
      }
    });
    const body = await res.json<{ error: { message: string } }>();

    expect(body.error.message).toMatch(/taskPushNotificationConfig\.token/);
  });

  it("rejects a push config whose url is not a URL", async () => {
    const res = await authed({
      request: { message },
      configuration: {
        taskPushNotificationConfig: { url: "not a url", token: "t" }
      }
    });
    const body = await res.json<{ error: { message: string } }>();

    expect(body.error.message).toMatch(/not a valid URL/);
  });

  it("echoes the request id so a client can correlate the rejection", async () => {
    const res = await authed({ request: { message } });
    expect((await res.json<{ id: number }>()).id).toBe(7);
  });

  it("can be turned off for an agent that replies inline", async () => {
    const inline = createA2AWorker({
      manifest: hostManifest,
      tenants: { [TEST_TENANT]: tenantAgent("worker-spec-agent") },
      requirePushConfig: false
    });

    const res = await inline(
      post(sendMessage({ request: { message } }), {
        authorization: `Bearer ${await makeGatewayToken()}`,
        "A2A-Version": A2A_PROTOCOL_VERSION
      }),
      env
    );

    // Past the contract check, so it reaches dispatch — which these specs
    // deliberately do not provide. The point is only that it got that far.
    const body = await res.json<{ error?: { message: string } }>();
    expect(body.error?.message ?? "").not.toMatch(/taskPushNotificationConfig/);
  });
});

describe("protocol version negotiation", () => {
  it("refuses a caller that does not ask for a version the card advertises", async () => {
    // An absent header is read as 0.3 by the SDK, which a v1.0-only card does
    // not advertise — rejected here rather than silently mis-served.
    const res = await worker(
      post(sendMessage({}), {
        authorization: `Bearer ${await makeGatewayToken()}`
      }),
      env
    );
    const body = await res.json<{ id: number; error: { code: number } }>();

    expect(body.error).toBeDefined();
    expect(body.id).toBe(7);
  });
});
