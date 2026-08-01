import { SignJWT, type JWK } from "jose";
import { TaskState, type Task } from "@a2a-js/sdk";
import { V1PushNotificationSerializer } from "@a2a-js/sdk/server";
import { agentTextMessage } from "./parts.js";
import type { PlainTask } from "./task.js";

/**
 * Outbound push-notification (accept + notify) helpers — the "notify" half of the
 * async A2A contract. The gateway dispatches `SendMessage` with a
 * `taskPushNotificationConfig` (webhook `url` + validation `token`), we accept
 * immediately with a `submitted` Task, and later POST the terminal Task back to
 * that webhook. This module builds the Task shapes and signs + sends that
 * callback.
 *
 * The callback is authenticated exactly like the AgentCard: a short-lived EdDSA
 * JWT signed by `A2A_SIGNING_KEY`, whose protected header `kid`+`jku` must equal
 * the card's signing `kid`+`jku` (see {@link file://./card.ts} `signCard`) — the
 * gateway pinned those at registration (Trust-On-First-Use) and verifies the
 * callback token against that same public JWKS. No shared secret crosses the
 * boundary; only our public key is ever used to verify.
 */

/** JWS algorithm — must match the card + gateway (`EdDSA`). */
const ALG = "EdDSA";

/**
 * Header carrying the per-task validation `token` the gateway set in the
 * `taskPushNotificationConfig`. Echoed verbatim so the gateway can correlate the
 * callback to its pending task row. Must match looping-gateway's
 * `NOTIFICATION_TOKEN_HEADER` (`src/a2a/notifications/remote.ts`).
 */
export const NOTIFICATION_TOKEN_HEADER = "x-a2a-notification-token";

/**
 * Callback-JWT lifetime. The gateway enforces `maxTokenAge: 10m` with a 60s clock
 * tolerance, so keep this comfortably under that.
 */
const CALLBACK_TOKEN_TTL = "5m";

/**
 * The SDK's canonical v1.0 push-notification body encoder: the `StreamResponse`
 * envelope as protobuf-JSON, with content type `application/a2a+json`. v1.0
 * moved push notifications onto the same envelope the streaming transports use
 * (v0.3 POSTed a bare `Task`), so the encoding is the SDK's rather than ours —
 * the gateway decodes it with `StreamResponse.fromJSON`.
 */
const PUSH_SERIALIZER = new V1PushNotificationSerializer();

/** A Task snapshot in `state` carrying no message — nothing to say, only a state change. */
function buildBareTask(
  taskId: string,
  contextId: string,
  state: TaskState
): PlainTask {
  return {
    id: taskId,
    contextId,
    status: {
      state,
      message: undefined,
      timestamp: new Date().toISOString()
    },
    artifacts: [],
    history: [],
    metadata: undefined
  };
}

/**
 * The `submitted` Task we return synchronously to accept a turn (A2A §7.2). The
 * gateway only requires a non-empty `id`; the actual reply follows later via the
 * callback.
 */
export function buildSubmittedTask(
  taskId: string,
  contextId: string
): PlainTask {
  return buildBareTask(taskId, contextId, TaskState.TASK_STATE_SUBMITTED);
}

/**
 * The terminal `completed` Task for a turn the agent deliberately did not answer
 * (it called the `no_reply` tool — see the agent loop). Same
 * shape as {@link buildSubmittedTask}: **no `status.message` at all**.
 *
 * The callback is still POSTed. The gateway's pending row has to resolve — we
 * simply hand it nothing to post to Slack. There is no `messageId` because there
 * is no message, so unlike {@link buildCompletedTask} nothing needs a stable id
 * for the gateway to dedupe on: a `notify`-step retry re-delivers no content and
 * is idempotent by construction.
 */
export function buildNoReplyCompletedTask(
  taskId: string,
  contextId: string
): PlainTask {
  return buildBareTask(taskId, contextId, TaskState.TASK_STATE_COMPLETED);
}

/**
 * A Task snapshot POSTed to the gateway callback in a given `state`, carrying one
 * `agent` message. The gateway reads the reply from `status.message.parts`, so
 * the text lives there.
 */
function buildTaskUpdate(
  taskId: string,
  contextId: string,
  state: TaskState,
  text: string,
  messageId: string
): PlainTask {
  const task = buildBareTask(taskId, contextId, state);
  task.status.message = agentTextMessage({
    messageId,
    text,
    contextId,
    taskId
  });
  return task;
}

/**
 * A non-terminal `working` Task snapshot carrying an intermediate content message.
 * Streamed live from the DO as the tool loop emits content before the final reply.
 * `messageId` is derived from `${taskId}:${stepIndex}` — stable across re-runs (see
 * {@link agentTextMessage}) so the gateway dedupes correctly on workflow replay.
 */
export function buildWorkingTask(
  taskId: string,
  contextId: string,
  text: string,
  stepIndex: number
): PlainTask {
  return buildTaskUpdate(
    taskId,
    contextId,
    TaskState.TASK_STATE_WORKING,
    text,
    `${taskId}:${stepIndex}`
  );
}

/**
 * The terminal `completed` Task POSTed to the gateway callback. The `messageId` is
 * deterministic (`${taskId}:final`, not a fresh UUID) because this is built in the
 * workflow body, which re-runs on replay: a random id would change on a notify-step
 * retry and the gateway would dedupe the final message as a new one and double-post.
 */
export function buildCompletedTask(
  taskId: string,
  contextId: string,
  reply: string
): PlainTask {
  return buildTaskUpdate(
    taskId,
    contextId,
    TaskState.TASK_STATE_COMPLETED,
    reply,
    `${taskId}:final`
  );
}

/**
 * The terminal `failed` Task POSTed to the gateway callback — an unexpected,
 * non-transient failure aborted the turn.
 *
 * A2A v1.0 gives a task no structured error (`TaskStatus` is only
 * `{state, message, timestamp}`), so the state *is* the failure signal and `text`
 * is the only place to explain. Keep that text user-safe: the gateway renders it
 * to a human, under its own "⚠️ *Agent …* (failed):" prefix.
 *
 * Shares the `${taskId}:final` messageId with {@link buildCompletedTask} by
 * design: a Task terminates exactly once and the two states are mutually
 * exclusive, so only one of them is ever built and posted — and a notify retry
 * re-posts that same one under the same dedupe key.
 */
export function buildFailedTask(
  taskId: string,
  contextId: string,
  text: string
): PlainTask {
  return buildTaskUpdate(
    taskId,
    contextId,
    TaskState.TASK_STATE_FAILED,
    text,
    `${taskId}:final`
  );
}

/**
 * Sign the callback JWT the gateway verifies against our pinned card key. The
 * protected header mirrors the card signature (`kid`+`jku`); `aud` must equal the
 * exact webhook URL the gateway handed us in the `taskPushNotificationConfig`.
 */
export async function signCallbackJwt(
  privateJwk: JWK & { kid: string },
  opts: { jku: string; aud: string }
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG, kid: privateJwk.kid, jku: opts.jku })
    .setAudience(opts.aud)
    .setIssuedAt()
    .setExpirationTime(CALLBACK_TOKEN_TTL)
    .sign(privateJwk);
}

/**
 * POST a Task snapshot to the gateway's push-notification webhook, wrapped in the
 * v1.0 `StreamResponse` envelope. Returns the raw `Response` so the caller (the
 * workflow's `notify` step) can decide whether a non-2xx warrants a retry.
 */
export async function postNotification(
  url: string,
  token: string,
  jwt: string,
  task: Task
): Promise<Response> {
  const { body, contentType } = PUSH_SERIALIZER.serialize({
    payload: { $case: "task", value: task }
  });
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": contentType,
      authorization: `Bearer ${jwt}`,
      [NOTIFICATION_TOKEN_HEADER]: token
    },
    body
  });
}
