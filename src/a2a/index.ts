/**
 * `@loopingai/core/a2a` — the A2A protocol adapter.
 *
 * The zero-trust contract in both directions (verify the gateway with its public
 * JWKS, prove ourselves with ours), the accept-and-notify task lifecycle, and the
 * narrowed task types that survive Durable Object RPC. Nothing here knows what an
 * agent *does* — past {@link A2AExecutor} everything is plain strings.
 *
 * ## The wire values come from `@loopingai/a2a-protocol`
 *
 * Claim names, the algorithm, the well-known paths and the audience rule are a
 * two-sided contract with a token issuer, and the issuer — looping-gateway — is
 * not an agent and must not import this package. They live in a zero-dependency
 * leaf both sides depend on, and are re-exported here so an agent's imports are
 * unchanged: `IDENTITY_CLAIM`, `TENANT_CLAIM`, `A2A_RPC_PATH` and
 * `GatewayIdentity` still come from `@loopingai/core/a2a`.
 *
 * The pure helpers are re-exported too, because an agent that builds a URL by
 * hand is an agent that can disagree with the gateway about it.
 */

export {
  A2A_JWS_ALG,
  audienceFor,
  endpointUrl,
  jwksUrl
} from "@loopingai/a2a-protocol";

export {
  IDENTITY_CLAIM,
  TENANT_CLAIM,
  GatewayAuthError,
  bearerToken,
  normalizeGatewayOrigins,
  verifyGatewayToken,
  type GatewayIdentity,
  type VerifyOptions
} from "./verify.js";

export {
  A2A_RPC_PATH,
  buildBaseCard,
  signCard,
  wireCard,
  parsePrivateJwk,
  publicCardJwks,
  type AgentManifest,
  type BuildCardOptions,
  type CardSigningConfig,
  type WireAgentCard
} from "./card.js";

export {
  NOTIFICATION_TOKEN_HEADER,
  buildSubmittedTask,
  buildWorkingTask,
  buildCompletedTask,
  buildFailedTask,
  buildNoReplyCompletedTask,
  signCallbackJwt,
  postNotification
} from "./notify.js";

export { callerContext } from "./caller.js";

export {
  createPushChannel,
  type PushChannel,
  type TurnPushContext
} from "./push.js";

export {
  taskStateLabel,
  type PlainArtifact,
  type PlainMessage,
  type PlainPart,
  type PlainStatus,
  type PlainTask
} from "./task.js";

export {
  textPart,
  partsText,
  textOf,
  agentTextMessage,
  inboundText,
  InboundPartError,
  MAX_INBOUND_TEXT_BYTES
} from "./parts.js";

export { buildCallContext, extensionHeaders } from "./context.js";

export { DurableTaskStore } from "./task-store.js";

export {
  A2AExecutor,
  workflowIdForMessage,
  ignoreAlreadyExists,
  type AcceptedTurn,
  type ExecutorConfig,
  type TurnStarter
} from "./executor.js";

export type {
  AgentResolver,
  TaskAgent,
  TaskListPage,
  TaskListQuery
} from "./agent-stub.js";
