/**
 * `@loopingai/core` — the mandatory foundation for a Looping agent.
 *
 * This root entry carries only what nearly every consumer touches: the plugin
 * contract, the config shape, the runtime factory, and the platform facts.
 * Everything else lives behind a subpath (`/a2a`, `/agent`, `/db`, `/subtasks`,
 * `/subagent`, `/worker`, `/testing`), so importing the delegation layer does not
 * pull in the A2A adapter and importing the test harness never reaches a
 * production bundle.
 */

export {
  createAgentRuntime,
  RuntimeSetupError,
  buildRecipeTools,
  collectToolFamilies,
  type AgentRuntime,
  type CreateAgentRuntimeOptions
} from "./runtime/index.js";

export {
  PLUGIN_CONTRACT_VERSION,
  definePlugin,
  type AgentPlugin,
  type EmitProgress,
  type EnrichResultContext,
  type PluginRequirements,
  type RecipeToolSet,
  type ResolveRuntimeContext,
  type ToolFamilyBuilder,
  type ToolFamilyContext
} from "./contract/plugin.js";

export type {
  DelegationNames,
  RecipeLimits,
  ResolvedRecipe,
  SubtaskParams,
  SubtaskParamsSchema,
  SubtaskParamsShape,
  SubtaskTypeSpec,
  ValidatedRecipe
} from "./contract/recipe.js";

export {
  RecipeValidationError,
  resolveLimits,
  validateRecipe,
  type RecipePolicy
} from "./contract/validation.js";

export {
  ConfigError,
  DEFAULT_CORE_CONFIG,
  resolveConfig,
  type AgentLimits,
  type CoreConfig,
  type CoreConfigOverrides,
  type ModelConfig,
  type RecallConfig,
  type SessionConfig
} from "./config.js";

export {
  parseGatewayOrigins,
  type A2ASecretsEnv,
  type AiEnv,
  type CoreEnv
} from "./env.js";

export {
  CHUNK_SOFT_MS,
  MAX_CHUNKS_PER_BRANCH,
  STEP_TIMEOUT_MS,
  STEPS_PER_INSTANCE
} from "./platform.js";

export type { PluginStore } from "./db/db.js";

export {
  makeWorkspaceHandle,
  WorkspaceLimitError,
  WORKSPACE_MAX_FILES,
  WORKSPACE_MAX_FILE_BYTES,
  type WorkspaceBacking,
  type WorkspaceEntry,
  type WorkspaceHandle
} from "./subagent/workspace.js";
