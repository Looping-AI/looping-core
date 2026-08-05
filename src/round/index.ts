/**
 * `@loopingai/core/round` — the delegating round loop.
 *
 * A round agent answers the user or hands work to isolated subagents, waits for
 * their durable results, and decides again. This subpath ships the whole
 * mechanism of that: the round loop and its primary→fallback→repair ladder
 * ({@link runTurn}), the durable Workflow orchestration with its DAG wave
 * scheduler ({@link runHandleTask}), the Durable Object body ({@link
 * RoundAgentBase}), and the subagent facet host ({@link RecipeSubagentHost}).
 *
 * **Opt-in, and its own subpath on purpose.** An agent whose turn is a single
 * inference — one that never delegates — imports none of this and carries none of
 * it in its bundle. Core's root barrel does not re-export it.
 *
 * **Core still ships no prompt copy.** Everything the model and the user read
 * comes from the {@link RoundPolicy} an agent supplies: the round contract, the
 * budget-spent note, and the three user-facing strings. That is the line — core
 * owns the machine, you own the words.
 */

export type { RoundPolicy } from "./policy.js";

export { RoundAgentBase } from "./agent.js";

export { RecipeSubagentHost, type SubagentClass } from "./subagent.js";

export {
  runHandleTask,
  type HandleTaskDeps,
  type HandleTaskParams
} from "./workflow.js";

export {
  buildTurnInstructions,
  joinSuccessfulBranches,
  renderTurnMessages,
  runTurn,
  type RoundMode,
  type RunTurnArgs,
  type RunTurnOutcome,
  type TurnInstructions
} from "./turn.js";
