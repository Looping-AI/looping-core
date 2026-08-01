import type { ToolSet } from "ai";
import type { PluginStore } from "../db/db.js";
import type { WorkspaceHandle } from "../subagent/workspace.js";
import type {
  ProgressEvent,
  RecipeExecutionRequest,
  RecipeExecutionResult,
  SubtaskRuntime
} from "../subtasks/types.js";
import type { SubtaskParams, SubtaskTypeSpec } from "./recipe.js";

/**
 * The plugin contract — everything an independently-packaged capability may
 * contribute to an agent, and the only thing core knows about one.
 *
 * Nothing in core imports a plugin. A plugin imports core (type-only wherever it
 * can) and is registered by the *host* at DO start. That direction is what makes
 * bundle growth proportional to what an agent actually installs, and it is
 * structural rather than a tree-shaker's opinion.
 */

/**
 * The contract version a plugin was built against.
 *
 * Three separate repos means a contract change is a three-repo publish train, and
 * the failure mode of a skew is a structural-type mismatch several frames from
 * its cause. `createAgentRuntime` asserts this instead, so a mismatched plugin
 * fails at DO start with a sentence naming the plugin and both versions.
 *
 * The contract is **additive-only** within a major: new capabilities arrive as
 * optional fields on {@link AgentPlugin}. Removing or re-typing an existing field
 * requires a major and a bump here.
 */
export const PLUGIN_CONTRACT_VERSION = 1;

/**
 * Emit a user-facing progress note from inside a tool (e.g. a level-up in a
 * game, a milestone in a long scrape). The resumable runner collects these and
 * ends the current chunk so the parent can post them promptly. Best-effort — the
 * runner never lets a progress note affect generation.
 */
export type EmitProgress = (event: ProgressEvent) => void;

/**
 * Everything a tool family needs to build its tools, closed over so none of it
 * is ever model input.
 *
 * Note what is **not** here: the Worker `env`. The predecessor passed it, which
 * a published package cannot do — `Env` is the ambient interface `wrangler
 * types` generates into a consumer's `worker-configuration.d.ts` and does not
 * exist outside their app. A plugin takes its secrets and bindings as *config at
 * instantiation* instead, which is also the only thing that works on Workers,
 * where `env` does not exist at module scope.
 */
export interface ToolFamilyContext<TRuntime = SubtaskRuntime> {
  /** The execution's durable file store. */
  workspace: WorkspaceHandle;
  emitProgress: EmitProgress;
  /**
   * The subtask's validated params — the ids its type declared it needs. Chosen
   * by the delegating main agent and checked against its type's contract before
   * this execution began, so a family may read them directly; they are not this
   * model's input.
   */
  params: SubtaskParams;
  /**
   * Session state the parent resolved for this execution — what no model could
   * supply and none should be asked to. Opaque to core; a plugin narrows it to
   * whatever its own {@link AgentPlugin.resolveRuntime} wrote.
   */
  runtime: TRuntime;
}

/**
 * A tool family's contribution: its tools, plus an optional `abort` hook the
 * facet runs on cancellation to release external state the family acquired.
 *
 * Anything the hook needs must be reconstructible from the workspace, so it is
 * safe to run on a fresh isolate after eviction.
 */
export interface RecipeToolSet<TRuntime = SubtaskRuntime> {
  tools: ToolSet;
  abort?: (ctx: ToolFamilyContext<TRuntime>) => Promise<void>;
}

/** Builds one tool family's contribution for a single execution. */
export type ToolFamilyBuilder<TRuntime = SubtaskRuntime> = (
  ctx: ToolFamilyContext<TRuntime>
) => RecipeToolSet<TRuntime>;

/** What the parent knows when resolving an execution's runtime state. */
export interface ResolveRuntimeContext {
  taskId: string;
  subtaskId: number;
  type: string;
  params: SubtaskParams;
  toolFamilies: readonly string[];
}

/** What the parent knows when a plugin gets to enrich a terminal result. */
export interface EnrichResultContext<TRuntime = SubtaskRuntime> {
  request: RecipeExecutionRequest;
  runtime: TRuntime;
}

/** Bindings and secrets a plugin needs the *host* to provide in `wrangler.jsonc`. */
export interface PluginRequirements {
  /** Secret names, e.g. `["ARC_API_KEY"]`. */
  secrets?: readonly string[];
  /** Binding names, e.g. `["BROWSER"]`. */
  bindings?: readonly string[];
}

export interface AgentPlugin<TRuntime = SubtaskRuntime> {
  /** Stable identifier, unique across installed plugins. */
  key: string;
  /**
   * The {@link PLUGIN_CONTRACT_VERSION} this plugin was built against. Set it
   * from the imported constant, never as a literal — the point is that it moves
   * with the core the plugin compiled against.
   */
  contractVersion: number;

  // --- subagent side ---

  /**
   * The subtask type this plugin makes delegable, and the recipe it runs under.
   * A plugin that only contributes main-agent tools declares none.
   */
  subtaskType?: SubtaskTypeSpec;
  /**
   * Tool families this plugin registers, keyed by family name. A recipe selects
   * families by name; a name no installed plugin registers is dropped by
   * `validateRecipe`, so the legal set is exactly what is installed.
   */
  toolFamilies?: Record<string, ToolFamilyBuilder<TRuntime>>;

  // --- main-agent side ---

  /** Tools offered to the *main* agent (e.g. a catalogue lookup before delegating). */
  mainAgentTools?: () => ToolSet;
  /**
   * What the main agent is told it can do with this domain, rendered into its
   * soul alongside the other capability blocks.
   */
  capability?: string;

  // --- parent-side lifecycle hooks ---

  /**
   * Resolve the session state an execution needs and no model can supply — a
   * leased external resource, a session handle, a cookie jar.
   *
   * Called by the parent before each chunk, and deliberately outside the
   * execution's fingerprint: what it returns can legitimately change between two
   * chunks of one run, and must not make a retry look like different work.
   */
  resolveRuntime?: (ctx: ResolveRuntimeContext) => Promise<TRuntime>;
  /**
   * Amend a terminal result before it is persisted — e.g. append a score the
   * subagent had no way to read. Returning the result unchanged is always valid.
   */
  enrichResult?: (
    ctx: EnrichResultContext<TRuntime>,
    result: RecipeExecutionResult
  ) => Promise<RecipeExecutionResult>;
  /** Release anything {@link resolveRuntime} acquired, when an execution is canceled. */
  onAbort?: (ctx: ResolveRuntimeContext) => Promise<void>;

  // --- storage + requirements ---

  /** Tables this plugin owns, outside core's migration journal. See {@link PluginStore}. */
  store?: PluginStore;
  /**
   * Bindings and secrets the host must declare in `wrangler.jsonc`. A plugin
   * cannot add its own binding, so declaring them lets startup fail with a
   * readable message instead of at the first tool call, in a request a user is
   * waiting on.
   */
  requires?: PluginRequirements;
}

/**
 * Identity helper that pins {@link AgentPlugin.contractVersion} for you and gives
 * a plugin author inference on `TRuntime`.
 *
 * ```ts
 * export function arcAgi(config: { apiKey: string }) {
 *   return definePlugin<ArcRuntime>({ key: "arc-agi", … });
 * }
 * ```
 */
export function definePlugin<TRuntime = SubtaskRuntime>(
  plugin: Omit<AgentPlugin<TRuntime>, "contractVersion"> & {
    contractVersion?: number;
  }
): AgentPlugin<TRuntime> {
  return {
    ...plugin,
    contractVersion: plugin.contractVersion ?? PLUGIN_CONTRACT_VERSION
  };
}
