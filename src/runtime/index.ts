import type { ToolSet } from "ai";
import {
  resolveConfig,
  type CoreConfig,
  type CoreConfigOverrides
} from "../config.js";
import {
  PLUGIN_CONTRACT_VERSION,
  type AgentPlugin,
  type EnrichResultContext,
  type ResolveRuntimeContext,
  type ToolFamilyBuilder
} from "../contract/plugin.js";
import type { PluginStore } from "../db/db.js";
import type { RecipePolicy } from "../contract/validation.js";
import {
  makeSubtaskTypes,
  type SubtaskTypeRegistry
} from "../subtasks/subtask-types.js";
import type {
  RecipeExecutionResult,
  SubtaskRuntime
} from "../subtasks/types.js";
import { collectToolFamilies } from "./tool-families.js";

export { buildRecipeTools, collectToolFamilies } from "./tool-families.js";

/**
 * The agent runtime: everything that used to be a module-level constant,
 * resolved once per Durable Object instance from the host's config and its
 * installed plugins.
 *
 * This is the whole point of the package split. In the predecessor repo the
 * subtask registry was imported at module scope and every derived value — the
 * type map, the delegate tool's enum and description, the round contract, the
 * known-tool-family allowlist — was computed at *import time*. That made the
 * registry unoverridable, pulled every domain's module into every bundle, and
 * could not read `env`, which does not exist at module scope on Workers.
 *
 * Build it in `onStart`:
 *
 * ```ts
 * async onStart() {
 *   this.runtime = createAgentRuntime({
 *     config: { model: { chatModelId: "…" } },
 *     plugins: plugins(this.env)
 *   });
 * }
 * ```
 */
export interface AgentRuntime {
  config: CoreConfig;
  plugins: readonly AgentPlugin[];
  /** The installed subtask types — what `delegate` may name. */
  types: SubtaskTypeRegistry;
  /** Every tool family the installed plugins registered, by name. */
  toolFamilies: ReadonlyMap<string, ToolFamilyBuilder>;
  /** The capability boundary `validateRecipe` enforces. */
  policy: RecipePolicy;
  /** Plugin-owned stores, to hand to `new AgentDB(storage, { stores })`. */
  stores: readonly PluginStore[];
  /** Every binding and secret the installed plugins require of the host. */
  requirements: { secrets: string[]; bindings: string[] };

  /** The plugin that declared a subtask type, or null. */
  pluginForType(type: string): AgentPlugin | null;
  /** Tools the installed plugins offer the *main* agent, merged. */
  mainAgentTools(): ToolSet;
  /**
   * Every plugin's `capability` block, for the main agent's soul. Returns `""`
   * when none declares one, so a call site can append unconditionally.
   */
  renderCapabilities(): string;

  /**
   * Resolve the session state an execution needs, by asking the plugin that owns
   * its type. Returns `{}` for a type whose plugin declares no
   * `resolveRuntime` — most of them.
   */
  resolveRuntime(ctx: ResolveRuntimeContext): Promise<SubtaskRuntime>;
  /** Let the owning plugin amend a terminal result before it is persisted. */
  enrichResult(
    ctx: EnrichResultContext,
    result: RecipeExecutionResult
  ): Promise<RecipeExecutionResult>;
  /** Let the owning plugin release whatever `resolveRuntime` acquired. */
  onAbort(ctx: ResolveRuntimeContext): Promise<void>;
}

export interface CreateAgentRuntimeOptions {
  plugins: readonly AgentPlugin[];
  config?: CoreConfigOverrides;
  /**
   * Verify that every secret and binding the plugins declared is actually
   * present, given the Worker `env`. Off by default because core cannot know
   * which of a consumer's bindings are optional; pass `env` to switch it on.
   */
  env?: Record<string, unknown>;
}

/**
 * Thrown when the installed plugins and the host disagree — a contract-version
 * skew, a duplicate key, or a missing binding. Always at DO start, never mid-request.
 */
export class RuntimeSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeSetupError";
  }
}

export function createAgentRuntime(
  options: CreateAgentRuntimeOptions
): AgentRuntime {
  const config = resolveConfig(options.config);
  const plugins = options.plugins;

  // --- contract + identity checks, all up front -----------------------------

  const byKey = new Map<string, AgentPlugin>();
  for (const plugin of plugins) {
    if (byKey.has(plugin.key)) {
      throw new RuntimeSetupError(
        `duplicate plugin key "${plugin.key}" — two installed plugins claim it`
      );
    }
    byKey.set(plugin.key, plugin);

    if (plugin.contractVersion !== PLUGIN_CONTRACT_VERSION) {
      throw new RuntimeSetupError(
        `plugin "${plugin.key}" was built against plugin contract v${plugin.contractVersion}, ` +
          `but this @loopingai/core speaks v${PLUGIN_CONTRACT_VERSION}. ` +
          "Upgrade whichever of the two is behind — they publish from separate repos, " +
          "so a version train can leave one lagging."
      );
    }
  }

  // --- what the plugins contribute ------------------------------------------

  const specs = plugins.flatMap((p) => (p.subtaskType ? [p.subtaskType] : []));
  const types = makeSubtaskTypes(specs);
  const toolFamilies = collectToolFamilies(plugins);

  const typeOwner = new Map<string, AgentPlugin>();
  for (const plugin of plugins) {
    if (plugin.subtaskType) typeOwner.set(plugin.subtaskType.key, plugin);
  }

  const stores = plugins.flatMap((p) => (p.store ? [p.store] : []));

  const secrets = [
    ...new Set(plugins.flatMap((p) => [...(p.requires?.secrets ?? [])]))
  ];
  const bindings = [
    ...new Set(plugins.flatMap((p) => [...(p.requires?.bindings ?? [])]))
  ];

  if (options.env) {
    const missing: string[] = [];
    for (const plugin of plugins) {
      for (const name of [
        ...(plugin.requires?.secrets ?? []),
        ...(plugin.requires?.bindings ?? [])
      ]) {
        const value = options.env[name];
        if (value === undefined || value === null || value === "") {
          missing.push(`${name} (required by "${plugin.key}")`);
        }
      }
    }
    if (missing.length > 0) {
      throw new RuntimeSetupError(
        `missing bindings or secrets: ${missing.join(", ")}. ` +
          "A plugin cannot add its own wrangler binding — declare these in wrangler.jsonc " +
          "(and `wrangler secret put` the secrets)."
      );
    }
  }

  const policy: RecipePolicy = {
    modelAllowlist: new Set([
      config.model.chatModelId,
      config.model.fallbackChatModelId
    ]),
    defaultPrimaryModelId: config.model.chatModelId,
    defaultFallbackModelId: config.model.fallbackChatModelId,
    knownToolFamilies: new Set(toolFamilies.keys()),
    baselineLimits: config.subagentLimits
  };

  const pluginForType = (type: string): AgentPlugin | null =>
    typeOwner.get(type) ?? null;

  return {
    config,
    plugins,
    types,
    toolFamilies,
    policy,
    stores,
    requirements: { secrets, bindings },

    pluginForType,

    mainAgentTools(): ToolSet {
      const tools: ToolSet = {};
      for (const plugin of plugins) {
        if (plugin.mainAgentTools)
          Object.assign(tools, plugin.mainAgentTools());
      }
      return tools;
    },

    renderCapabilities(): string {
      const blocks: string[] = [];
      for (const plugin of plugins) {
        if (plugin.capability) blocks.push(plugin.capability);
      }
      return blocks.join("\n\n");
    },

    async resolveRuntime(ctx: ResolveRuntimeContext): Promise<SubtaskRuntime> {
      const plugin = pluginForType(ctx.type);
      if (!plugin?.resolveRuntime) return {};
      return (await plugin.resolveRuntime(ctx)) as SubtaskRuntime;
    },

    async enrichResult(
      ctx: EnrichResultContext,
      result: RecipeExecutionResult
    ): Promise<RecipeExecutionResult> {
      const plugin = pluginForType(ctx.request.type);
      if (!plugin?.enrichResult) return result;
      return plugin.enrichResult(ctx, result);
    },

    async onAbort(ctx: ResolveRuntimeContext): Promise<void> {
      const plugin = pluginForType(ctx.type);
      if (plugin?.onAbort) await plugin.onAbort(ctx);
    }
  };
}
