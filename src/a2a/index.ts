/**
 * `@loopingai/core/a2a` — the A2A protocol adapter.
 *
 * The zero-trust contract in both directions (verify the gateway with its public
 * JWKS, prove ourselves with ours), the accept-and-notify task lifecycle, and the
 * narrowed task types that survive Durable Object RPC. Nothing here knows what an
 * agent *does* — past {@link A2AExecutor} everything is plain strings.
 */

export {
  IDENTITY_CLAIM,
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
