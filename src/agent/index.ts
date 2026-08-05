/**
 * `@loopingai/core/agent` — the primitives a loop is built from.
 *
 * The session, the model pair with its fallback, the budget, and the
 * control-tool abstraction that turns "the model called something that ends the
 * round" into a checked value. Everything both predecessor loops needed
 * identically, and nothing about how a round is shaped.
 *
 * This subpath ships **no loop** — that is what makes it importable by one. A
 * loop module needs these primitives without also pulling in a Durable Object
 * base class and drizzle, which is why `LoopingAgent` lives in
 * `@loopingai/core/host` and the delegating round loop in
 * `@loopingai/core/round`.
 *
 * Core as a whole *does* now ship a loop, opt-in, in `/round`. The rule it
 * still keeps is narrower and better: **core ships no prompt copy and no
 * policy** — see `AGENTS.md`, "The line core does not cross". An agent that
 * wants a different round shape imports none of `/round` and builds it from
 * exactly what is here.
 */

export { newTurnBudget, stepAllowance, type TurnBudget } from "./budget.js";

export {
  createModelRuntime,
  type GatewayMetadata,
  type ModelOverrides,
  type ModelPair,
  type ModelRuntime,
  type ModelRuntimeDeps
} from "./model.js";

export {
  appendOnce,
  buildAgentSession,
  notifyingCompaction,
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
  sessionMessage,
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
