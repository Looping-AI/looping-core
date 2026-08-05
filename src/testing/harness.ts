import { A2A_PROTOCOL_VERSION } from "@a2a-js/sdk";
import {
  A2A_RPC_PATH,
  NOTIFICATION_TOKEN_HEADER,
  endpointUrl,
  jwksUrl
} from "@loopingai/a2a-protocol";
import type { PlainTask } from "../a2a/task.js";
import { makeGatewayToken, TEST_TENANT } from "./auth.js";
import { AGENT_ORIGIN, GATEWAY_ORIGIN, gatewayPublicJwks } from "./fixtures.js";

/**
 * Drive one A2A turn against a Worker the way a gateway does.
 *
 * Core already shipped every *piece* of this — a token signer, Ed25519 fixtures,
 * a fake session, a scripted model — and no assembly, so every consumer wrote the
 * assembly themselves and got the same four things wrong first: the token's
 * audience is the **endpoint** and not the origin, the tenant claim has to match
 * the tenant in the body, `SendMessage` is refused without a push config, and the
 * gateway's own JWKS has to be reachable or verification fails before anything
 * interesting happens.
 *
 * None of that is a property of any one agent, so none of it should be written
 * more than once.
 *
 * ```ts
 * const harness = createAgentHarness({ worker, env, tenant: "reactive" });
 * using _ = harness.interceptGateway();
 *
 * const accepted = await harness.send("what's the weather?");
 * expect(accepted.status.state).toBe(TaskState.TASK_STATE_SUBMITTED);
 * ```
 *
 * What it covers is the **synchronous accept**: everything from the gateway's
 * bearer token to the `submitted` Task the Worker returns. The turn itself runs
 * in a Workflow the test runtime does not start, so assert on the callbacks with
 * {@link AgentHarness.callbacks} while driving the workflow body directly with a
 * fake `step`.
 */

/** The minimum of an `ExportedHandler` this harness calls. */
export interface HarnessWorker<TEnv> {
  fetch(request: Request, env: TEnv): Promise<Response> | Response;
}

export interface AgentHarnessOptions<TEnv> {
  /** The Worker module under test — usually `import worker from "@/index"`. */
  worker: HarnessWorker<TEnv>;
  /** The `env` the pool built from `wrangler.jsonc`. */
  env: TEnv;
  /** Which agent to address. Must be a tenant the Worker mounts. */
  tenant?: string;
  /** Where the Worker serves JSON-RPC. Defaults to core's `/a2a`. */
  rpcPath?: string;
  /** The origin the Worker is addressed on. Defaults to the test fixture's. */
  origin?: string;
}

/** One push notification the agent POSTed back, already decoded. */
export interface CapturedCallback {
  /** The `taskId` the callback was about. */
  taskId: string;
  /** The task state, e.g. `TASK_STATE_WORKING`. */
  state: string;
  /** The message text, joined across parts. `""` for a no-reply completion. */
  text: string;
  /** The per-task validation token echoed in the callback header. */
  token: string | null;
  /** The raw decoded body, for anything the projection above drops. */
  body: unknown;
}

export interface AgentHarness {
  /** The endpoint a token is minted for — the audience, not the origin. */
  readonly endpoint: string;
  /** The gateway webhook the agent is told to call back on. */
  readonly pushUrl: string;
  /**
   * Send one turn and return the accepted Task.
   *
   * Throws on a JSON-RPC error rather than returning it, so a spec asserting the
   * happy path fails with the agent's own message instead of on a later
   * `undefined`. Use {@link rpc} for the refusal cases.
   */
  send(text: string, options?: { taskId?: string }): Promise<PlainTask>;
  /**
   * One raw JSON-RPC call with a valid gateway token, returning the `Response`.
   * For specs about what the edge *refuses*.
   */
  rpc(body: unknown, init?: { token?: string }): Promise<Response>;
  /** A valid gateway token for this harness's tenant and endpoint. */
  token(overrides?: { tenant?: string }): Promise<string>;
  /**
   * Stub `fetch` so the gateway's JWKS resolves and every push callback is
   * captured instead of leaving the isolate.
   *
   * Returns a disposable — `using _ = harness.interceptGateway()` — that restores
   * the global on scope exit. Anything neither the JWKS nor the webhook 404s, so
   * an unexpected outbound call fails loudly rather than hanging.
   */
  interceptGateway(): Disposable;
  /** Callbacks captured since {@link interceptGateway}, in arrival order. */
  readonly callbacks: CapturedCallback[];
}

/** Project the push envelope onto the three fields a spec usually asserts. */
function projectCallback(
  body: unknown,
  token: string | null
): CapturedCallback {
  const task = (body as { task?: unknown }).task ?? body;
  const t = task as {
    id?: string;
    status?: { state?: string; message?: { content?: { text?: string }[] } };
  };
  const parts = t.status?.message?.content ?? [];
  return {
    taskId: t.id ?? "",
    state: t.status?.state ?? "",
    text: parts
      .map((p) => p.text ?? "")
      .join("")
      .trim(),
    token,
    body
  };
}

export function createAgentHarness<TEnv>(
  options: AgentHarnessOptions<TEnv>
): AgentHarness {
  const origin = options.origin ?? AGENT_ORIGIN;
  const rpcPath = options.rpcPath ?? A2A_RPC_PATH;
  // The audience a gateway actually mints: the endpoint this deployment serves,
  // which is also exactly what its card advertises as its interface. Composed
  // with the protocol package's own helper, so a harness cannot agree with the
  // verifier while disagreeing with what a real gateway would send.
  const endpoint = endpointUrl(origin, rpcPath);
  const tenant = options.tenant ?? TEST_TENANT;
  const pushUrl = `${GATEWAY_ORIGIN}/a2a/push`;
  const pushToken = "harness-push-token";
  const callbacks: CapturedCallback[] = [];

  const token = (overrides: { tenant?: string } = {}) =>
    makeGatewayToken({
      audience: endpoint,
      tenant: overrides.tenant ?? tenant
    });

  const rpc = async (
    body: unknown,
    init: { token?: string } = {}
  ): Promise<Response> =>
    options.worker.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "A2A-Version": A2A_PROTOCOL_VERSION,
          authorization: `Bearer ${init.token ?? (await token())}`
        },
        body: JSON.stringify(body)
      }),
      options.env
    ) as Promise<Response>;

  return {
    endpoint,
    pushUrl,
    callbacks,
    token,
    rpc,

    async send(text, sendOptions = {}) {
      const messageId = crypto.randomUUID();
      const res = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          tenant,
          request: {
            message: {
              messageId,
              role: "ROLE_USER",
              content: [{ text }],
              ...(sendOptions.taskId ? { taskId: sendOptions.taskId } : {})
            },
            configuration: {
              // Required by the accept-and-notify contract: an agent that replies
              // out of band and is given nowhere to call back has accepted a turn
              // it can never answer.
              taskPushNotificationConfig: { url: pushUrl, token: pushToken }
            }
          }
        }
      });

      const envelope = await res.json<{
        error?: { code: number; message: string };
        result?: { task?: PlainTask } & PlainTask;
      }>();
      if (envelope.error) {
        throw new Error(
          `SendMessage was refused (${envelope.error.code}): ${envelope.error.message}`
        );
      }
      const result = envelope.result;
      const task = (result?.task ?? result) as PlainTask | undefined;
      if (!task) {
        throw new Error(
          `SendMessage returned no task: ${JSON.stringify(envelope)}`
        );
      }
      return task;
    },

    interceptGateway() {
      const original = globalThis.fetch;
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit
      ): Promise<Response> => {
        const url = typeof input === "string" ? input : String(input);

        // The gateway's public JWKS — without it every token fails to verify and
        // every spec below it reports a 401 that has nothing to do with its subject.
        if (url === jwksUrl(GATEWAY_ORIGIN)) {
          return new Response(gatewayPublicJwks(), {
            headers: { "content-type": "application/json" }
          });
        }

        if (url === pushUrl) {
          const request = new Request(input as RequestInfo, init);
          const body: unknown = await request.json().catch(() => null);
          callbacks.push(
            projectCallback(
              body,
              request.headers.get(NOTIFICATION_TOKEN_HEADER)
            )
          );
          return new Response(null, { status: 202 });
        }

        // Anything else is a call this harness did not expect. 404 rather than
        // pass through: a spec that silently reaches the real network is a spec
        // that passes for the wrong reason.
        return new Response(`unexpected outbound fetch: ${url}`, {
          status: 404
        });
      }) as typeof fetch;

      return {
        [Symbol.dispose]() {
          globalThis.fetch = original;
        }
      };
    }
  };
}
