/**
 * `@loopingai/core/agent` — the primitives a loop is built from.
 *
 * Core ships no loop. `turn.ts` / `loop.ts` are the agent's, because how a round
 * ends is the one thing every agent genuinely differs on. What core owns is
 * everything both predecessor loops needed identically: the session, the model
 * pair with its fallback, the budget, and the control-tool abstraction that
 * turns "the model called something that ends the round" into a checked value.
 */

export { newTurnBudget, stepAllowance, type TurnBudget } from "./budget.js";

export {
  createModelRuntime,
  type Embed,
  type GatewayMetadata,
  type ModelOverrides,
  type ModelPair,
  type ModelRuntime,
  type ModelRuntimeDeps
} from "./model.js";

export {
  appendOnce,
  archivingCompaction,
  buildAgentSession,
  type AgentSessionOptions,
  type SessionHost,
  type SessionLike
} from "./session.js";

export {
  deterministicSessionMessage,
  finalReplyMessageId,
  parseRoundAckMessageId,
  parseTurn,
  roundAckMessageId,
  sessionText,
  taskUserMessageId,
  toModelMessages,
  type ParsedTurn
} from "./history.js";

export {
  buildIntermediateContentHandler,
  isTransientAiError,
  type OnContent
} from "./inference.js";

export {
  ControlCallError,
  controlTools,
  controlToolSet,
  type ControlTool,
  type TurnDecision
} from "./control.js";

export {
  FINAL_REPLY_TOOL_NAME,
  finalReplyInputSchema,
  finalReplyTool
} from "./final-reply.js";
