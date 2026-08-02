import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { AGENT_CARD_PATH, A2A_PROTOCOL_VERSION } from "@a2a-js/sdk";
import { createA2AWorker, JWKS_PATH } from "./index.js";
import type { AgentManifest } from "../a2a/card.js";
import type { A2ASecretsEnv } from "../env.js";
import type { AgentResolver } from "../a2a/agent-stub.js";
import { makeGatewayToken } from "../testing/auth.js";
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

const manifest: AgentManifest = {
  name: "worker-spec-agent",
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
};

const env: A2ASecretsEnv = {
  A2A_SIGNING_KEY: JSON.stringify(TEST_AGENT_PRIVATE_JWK),
  GATEWAY_ORIGINS: JSON.stringify([GATEWAY_ORIGIN])
};

/** Never reached by these specs — every one is refused before dispatch. */
const resolveAgent: AgentResolver = () => {
  throw new Error("resolveAgent must not be reached in these specs");
};

const worker = createA2AWorker({
  manifest,
  resolveAgent,
  startTurn: async () => {}
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${AGENT_ORIGIN}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });

const sendMessage = (params: unknown) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "SendMessage",
  params
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

  it("serves a signed card whose jku points back at its own JWKS route", async () => {
    const res = await worker(
      new Request(`${AGENT_ORIGIN}/${AGENT_CARD_PATH}`),
      env
    );
    const card = await res.json<Record<string, unknown>>();

    expect(res.status).toBe(200);
    expect(card.name).toBe("worker-spec-agent");
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
 * Several agents in one Worker, each behind its own path prefix.
 *
 * Everything a mount answers on is already an option, so the only two things
 * that had to give were the pair of facts derived from the *origin*: which key
 * signs, and which audience a token must carry. With one agent per Worker the
 * origin is the agent and both defaults are right; with several it stops
 * identifying anything, which is what these specs pin.
 */
describe("several agents mounted in one Worker", () => {
  interface MultiEnv {
    A2A_SIGNING_KEY_PROACTIVE: string;
    GATEWAY_ORIGINS: string;
  }

  const multiEnv: MultiEnv = {
    A2A_SIGNING_KEY_PROACTIVE: JSON.stringify(TEST_AGENT_PRIVATE_JWK),
    GATEWAY_ORIGINS: JSON.stringify([GATEWAY_ORIGIN])
  };

  const mounted = createA2AWorker<MultiEnv>({
    manifest,
    resolveAgent,
    startTurn: async () => {},
    rpcPath: "/proactive/a2a",
    jwksPath: "/proactive/.well-known/jwks.json",
    audience: (url) => `${url.origin}/proactive`,
    secrets: (e) => ({
      signingKey: e.A2A_SIGNING_KEY_PROACTIVE,
      gatewayOrigins: e.GATEWAY_ORIGINS
    })
  });

  it("reads its signing key from the renamed secret", async () => {
    // `env` here carries no `A2A_SIGNING_KEY` at all, so serving a card proves
    // the rename is what was read rather than a fallback finding the default.
    const res = await mounted(
      new Request(`${AGENT_ORIGIN}/proactive/.well-known/jwks.json`),
      multiEnv
    );
    const body = await res.json<{ keys: Record<string, unknown>[] }>();

    expect(res.status).toBe(200);
    expect(body.keys[0].kid).toBe(TEST_AGENT_PRIVATE_JWK.kid);
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("advertises and signs under its own prefix", async () => {
    const res = await mounted(
      new Request(`${AGENT_ORIGIN}/proactive/${AGENT_CARD_PATH}`),
      multiEnv
    );
    const card = await res.json<{
      supportedInterfaces: { url: string }[];
      signatures: { protected: string }[];
    }>();

    expect(card.supportedInterfaces[0].url).toBe(
      `${AGENT_ORIGIN}/proactive/a2a`
    );

    // The `jku` has to resolve to *this* mount's JWKS, not the Worker root —
    // a gateway fetches the card's key from exactly this URL.
    const header = JSON.parse(
      atob(card.signatures[0].protected.replace(/-/g, "+").replace(/_/g, "/"))
    );
    expect(header.jku).toBe(`${AGENT_ORIGIN}/proactive/.well-known/jwks.json`);
  });

  it("refuses a token minted for a sibling mount", async () => {
    // The reason `audience` exists. Both mounts share an origin, so without it
    // this token verifies here too and "which agent was this for" is a question
    // nothing in the system is asking.
    const token = await makeGatewayToken({
      audience: `${AGENT_ORIGIN}/reactive`
    });
    const res = await mounted(
      new Request(`${AGENT_ORIGIN}/proactive/a2a`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(sendMessage({}))
      }),
      multiEnv
    );

    expect(res.status).toBe(401);
  });

  it("accepts a token minted for its own mount", async () => {
    const token = await makeGatewayToken({
      audience: `${AGENT_ORIGIN}/proactive`,
      identity: { name: "anonymous" }
    });
    const res = await mounted(
      new Request(`${AGENT_ORIGIN}/proactive/a2a`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(sendMessage({}))
      }),
      multiEnv
    );

    // 400, not 401: the token verified, and the call died one step later on the
    // keyless identity. That is the assertion — anything 401 would mean the
    // audience check rejected it.
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/identity missing key/);
  });
});

describe("the accept-and-notify contract", () => {
  const authed = async (params: unknown) =>
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
      manifest,
      resolveAgent,
      startTurn: async () => {},
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
