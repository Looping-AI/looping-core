/**
 * The plugin contract — the only thing core and a plugin package both name.
 *
 * Re-exported from the package root as well, so a plugin author writes
 * `import { definePlugin } from "@loopingai/core"` and nothing else.
 */

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
} from "./plugin.js";

export type {
  DelegationNames,
  RecipeLimits,
  ResolvedRecipe,
  SubtaskParams,
  SubtaskParamsSchema,
  SubtaskParamsShape,
  SubtaskTypeSpec,
  ValidatedRecipe
} from "./recipe.js";

export {
  RecipeValidationError,
  resolveLimits,
  validateRecipe,
  type RecipePolicy
} from "./validation.js";
