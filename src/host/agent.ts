import { Agent, type Schedule } from "agents";
import { TaskState, type Task } from "@a2a-js/sdk";
import { createAgentRuntime, type AgentRuntime } from "../runtime/index.js";
import type { AgentPlugin } from "../contract/plugin.js";
import {
  resolveConfig,
  type CoreConfig,
  type CoreConfigOverrides
} from "../config.js";
import type { A2ASecretsEnv, AiEnv } from "../env.js";
import { AgentDB, stateOf } from "../db/index.js";
import type { GatewayIdentity } from "../a2a/verify.js";
import { callerContext } from "../a2a/caller.js";
import type { PlainTask } from "../a2a/task.js";
import type { TaskListQuery } from "../a2a/agent-stub.js";
import {
  createPushChannel,
  type PushChannel,
  type TurnPushContext
} from "../a2a/push.js";
import { buildAgentSession, type SessionLike } from "../agent/session.js";
import {
  createModelRuntime,
  type GatewayMetadata,
  type ModelPair,
  type ModelRuntime
} from "../agent/model.js";
import type { PluginHost } from "./plugin-host.js";

/**
 * The Durable Object body every Looping agent has, whatever loop it runs.
 *
 * ## Why this is core's and not the app's
 *
 * It was the app's, in the starter, and it was written twice — once for the
 * delegating round agent, once for the single-turn proactive one. The two copies
 * were identical for ~180 lines: the memoized runtime/db/models getters, the
 * `onStart` that must await migrations before the SDK dispatches any RPC, the
 * cron registration guard, the session with its displacement fan-out, the
 * `identityKey` timing, and the task RPC surface.
 *
 * They did not stay identical. The second copy dropped `markWorking`'s
 * cancellation verdict on the floor and probed with a separate `getTask` before
 * writing a terminal Task — so a canceled task still burned a model call, and the
 * gateway could still receive a `completed` callback for a task the caller had
 * abandoned. Both are lifecycle invariants, both were documented in the first
 * copy, and neither is visible to a type checker or a linter.
 *
 * That is the argument for this class. **None of it is policy.** How a turn is
 * shaped, what ends it, what the model is told — all of that stays with the
 * agent, and an agent that wants a different loop simply does not extend
 * {@link file://../round/agent.ts RoundAgentBase}. What is here is the part where
 * being different is only ever a bug.
 *
 * ## The three seams
 *
 * ```ts
 * export class MyAgent extends LoopingAgent<Env> {
 *   protected agentConfig() { return MY_CONFIG; }
 *   protected agentPlugins(host: PluginHost<Env>) { return plugins(host); }
 *   protected agentSoul(capabilities: string) { return soulPrompt(capabilities); }
 * }
 * ```
 *
 * One Durable Object instance per verified caller (keyed by the gateway JWT's
 * `identity.key`), each owning **one continuous Session** — durable history plus
 * a self-edited `memory` block, backed by `this.sql`. All of a caller's turns, in
 * any channel or thread, accumulate into that one conversation.
 */
export abstract class LoopingAgent<
  TEnv extends Cloudflare.Env & AiEnv & A2ASecretsEnv = Cloudflare.Env &
    AiEnv &
    A2ASecretsEnv
> extends Agent<TEnv> {
  private session?: SessionLike;
  private _runtime?: AgentRuntime;
  private _models?: ModelRuntime;
  private _pair?: ModelPair;
  private _db?: AgentDB;

  /**
   * The verified caller this instance belongs to, set on the first turn.
   *
   * `onStart` runs before any request, so it is not known when `agentPlugins()`
   * is built — which is why anything per-caller takes a thunk. The DO is keyed
   * 1:1 by this value, so it is constant once set.
   */
  private identityKey?: string;

  /**
   * Test-only model injection. A **field**, not a constructor argument or an RPC
   * parameter, so it never appears on the generated DO stub: production callers
   * cannot reach it, and no model configuration crosses the RPC boundary.
   */
  modelsOverride?: ModelPair;

  // --- the seams a subclass fills ------------------------------------------

  /** This agent's config overrides. Merged onto core's baseline once, at start. */
  protected abstract agentConfig(): CoreConfigOverrides;

  /** This agent's installed capabilities. Conventionally its `./plugins.ts`. */
  protected abstract agentPlugins(host: PluginHost<TEnv>): AgentPlugin[];

  /**
   * This agent's identity, with the installed plugins' capability blocks already
   * rendered in. Core ships no prompt copy — this is yours to write.
   */
  protected abstract agentSoul(capabilities: string): string;

  // --- assembly -------------------------------------------------------------

  /**
   * Everything that would otherwise be a module-level constant, resolved once
   * per DO instance from this agent's config and its installed plugins.
   *
   * Resolving a registry at *import* time is the one thing the package split
   * exists to prevent: it freezes the registry before `env` exists (which on
   * Workers is always), defeats tree-shaking, and makes per-agent plugin
   * selection impossible.
   */
  protected get runtime(): AgentRuntime {
    return (this._runtime ??= createAgentRuntime({
      config: this.agentConfig(),
      plugins: this.agentPlugins(this.pluginHost()),
      // Opt in to verifying every plugin's declared bindings exist. Fails at DO
      // start with a sentence naming the plugin, rather than at the first tool
      // call inside a request someone is waiting on.
      env: this.env
    }));
  }

  /** The resolved config. */
  protected get config(): CoreConfig {
    return this.runtime.config;
  }

  /** The agent's database (drizzle + migrations), built once per DO instance. */
  protected get db(): AgentDB {
    return (this._db ??= new AgentDB(this.ctx.storage, {
      maxSubtasks: this.config.maxSubtasks,
      // Plugin-owned tables, applied after core's own migrations. A store that
      // throws fails DO start rather than being skipped — a plugin whose tables
      // are missing would otherwise fail at its first tool call.
      stores: this.runtime.stores
    }));
  }

  /** The model runtime for this instance, built lazily over the `AI` binding. */
  protected get models(): ModelRuntime {
    return (this._models ??= createModelRuntime({
      ai: this.env.AI,
      config: this.config.model
    }));
  }

  /**
   * What this agent's plugins are handed. Built from
   * {@link resolvedModelIds} rather than `this.config`, which would be a cycle —
   * building the runtime is what needs these.
   */
  protected pluginHost(): PluginHost<TEnv> {
    const model = this.resolvedModelIds();
    return {
      env: this.env,
      storage: this.ctx.storage,
      // A thunk, not a value — see `identityKey`.
      callerKey: () => this.requireIdentityKey(),
      primaryModelId: model.chatModelId,
      fallbackModelId: model.fallbackChatModelId,
      aiGatewayId: model.aiGatewayId
    };
  }

  /**
   * The model settings a locally-declared recipe runs on, resolved *before* the
   * runtime exists.
   *
   * Deliberately not `this.config` — that would be a cycle. `resolveConfig` is
   * cheap and pure and fills in core's defaults, so this is the same result the
   * runtime lands on; that matters because a recipe's models are checked against
   * `policy.modelAllowlist`, which is built from these very values.
   */
  private resolvedModelIds(): CoreConfig["model"] {
    return resolveConfig(this.agentConfig()).model;
  }

  async onStart(): Promise<void> {
    // Await migrations before the SDK dispatches any RPC — eliminates the race
    // between schema creation and first query on cold start / hibernation wake-up.
    await this.db.ensureReady();
    // Register the weekly cleanup cron once per DO instance (idempotent guard).
    const existing = await this.listSchedules({ type: "cron" });
    if (!existing.some((s) => s.callback === "cleanupOldTasks")) {
      await this.schedule("0 1 * * 0", "cleanupOldTasks", {});
    }
  }

  /**
   * Cron handler: delete task rows older than 30 days. Runs Sunday 01:00 UTC.
   *
   * A plugin's own tables are its business — core's journal does not reach them,
   * and neither does this sweep. A subclass with more durable state of its own
   * overrides {@link cleanupAgentState}.
   */
  async cleanupOldTasks(
    _payload: Record<string, never>,
    _schedule: Schedule
  ): Promise<void> {
    this.db.tasks.cleanup();
    this.cleanupAgentState();
  }

  /** Extra durable state to age out alongside the task rows. Default: none. */
  protected cleanupAgentState(): void {}

  /**
   * The main agent's primary/fallback pair. With `metadata` it builds a fresh
   * pair carrying that AI Gateway correlation tag (so a gateway log ties the call
   * to its task and round); without it — the Session's own compaction model — it
   * reuses a memoized default. A test `modelsOverride` always wins.
   */
  protected modelPair(metadata?: GatewayMetadata): ModelPair {
    if (this.modelsOverride) return this.modelsOverride;
    if (!metadata) return (this._pair ??= this.models.createModelPair());
    return this.models.createModelPair({ metadata });
  }

  /**
   * The one continuous Session for this caller (rebuilt from `this.sql` after
   * eviction). Memoized — `identity` is constant for the DO's life, since the DO
   * is keyed 1:1 by `identity.key`.
   *
   * `onMessagesDisplaced` is the whole integration for anything that wants the
   * messages a compaction folds away: core performs the compaction, so core
   * announces the loss, and the runtime fans it out to every plugin that asked.
   */
  getSession(identity: GatewayIdentity): SessionLike {
    this.identityKey ??= identity.key ?? undefined;
    const { session, model } = this.config;
    return (this.session ??= buildAgentSession(
      this,
      this.modelPair().primary(),
      {
        soul: () => this.agentSoul(this.runtime.renderCapabilities()),
        memoryDescription: session.memoryDescription,
        memoryMaxTokens: session.memoryMaxTokens,
        compactAfterTokens: session.compactAfterTokens,
        compactTailTokens: session.compactTailTokens,
        maxOutputTokens: model.maxOutputTokens,
        onMessagesDisplaced: this.runtime.onMessagesDisplaced
      }
    ));
  }

  /** The caller key, which is present on every path that can reach a plugin. */
  protected requireIdentityKey(): string {
    if (!this.identityKey) {
      throw new Error("identity.key is required for per-caller isolation");
    }
    return this.identityKey;
  }

  /** The gateway callback channel for one turn. See {@link PushChannel}. */
  protected push(context: TurnPushContext): PushChannel {
    return createPushChannel(this.env.A2A_SIGNING_KEY, context);
  }

  /**
   * The per-request system-prompt suffix describing the verified caller.
   *
   * A rendering of a protocol fact rather than prompt copy, so core supplies one
   * — see {@link callerContext}. Override it to name what a workspace id means in
   * your deployment; do not use it to say who the *user* is, which this is not.
   */
  protected callerContext(identity: GatewayIdentity): string {
    return callerContext(identity);
  }

  // --- Async task state (accept + notify) ----------------------------------
  //
  // A thin RPC surface over `AgentDB`'s `tasks` table. Native RPC methods — the
  // DO is never a network-reachable server — called by the Workflow, which
  // cannot touch this SQLite directly.
  //
  // The Task-returning methods return `PlainTask`: the SDK `Task` narrowed to
  // what survives Cloudflare's RPC types. Returning the raw SDK `Task` breaks
  // the generated DO-stub types (under v1.0 it blows past TypeScript's
  // instantiation-depth limit).

  async beginTask(input: {
    messageId: string;
    taskId: string;
    contextId: string;
  }): Promise<PlainTask> {
    return this.db.tasks.begin(input);
  }

  async getTask(taskId: string): Promise<PlainTask | null> {
    return this.db.tasks.get(taskId);
  }

  async listTasks(
    query: TaskListQuery
  ): Promise<{ tasks: PlainTask[]; totalSize: number }> {
    return this.db.tasks.list(query);
  }

  /**
   * Persist a Task, returning **whether the guarded write applied**.
   *
   * That boolean is the cancellation check, and a caller must key its callback on
   * it: `AgentDB` refuses to write a terminal state over a `canceled` row and
   * does that read and write in one synchronous pass inside the DO. Probing with
   * {@link getTask} first and saving second leaves a window — between the two
   * calls, and again between the save and the notify — in which a cancel lands
   * and the gateway still receives a `completed` callback.
   *
   * A `canceled` state routes to {@link markCanceled} instead of a plain write,
   * so a `tasks/cancel` arriving through the a2a-js TaskStore and one arriving
   * through {@link cancelTask} converge on the same interruption path.
   */
  async saveTask(task: Task): Promise<boolean> {
    if (stateOf(task) === TaskState.TASK_STATE_CANCELED) {
      return (await this.markCanceled(task.id, task)) !== null;
    }
    return this.db.tasks.save(task);
  }

  /**
   * Move the Task to `working`. Returns `"canceled"` when the caller cancelled
   * first — read it and stop, rather than probing with a separate
   * {@link getTask}, which reopens the gap between asking and acting.
   *
   * Anything else is `"ok"`, including an unknown row and a row already `working`
   * (a replayed step): only an actual cancellation stops the pipeline.
   */
  async markWorking(taskId: string): Promise<"ok" | "canceled"> {
    return this.db.tasks.markWorking(taskId);
  }

  async cancelTask(taskId: string): Promise<PlainTask | null> {
    return this.markCanceled(taskId);
  }

  /**
   * The one place a Task becomes canceled: flip the row — terminal, so every
   * non-canceled write is refused afterwards — then interrupt whatever is still
   * running for it.
   *
   * `task` is supplied when the caller already built the canceled Task (the
   * a2a-js cancel branch attaches its own status message); otherwise the row's
   * own guarded flip produces it. Both paths are guarded against the same race:
   * a task that already reached `completed`/`failed` refuses the write, and its
   * verdict — not a `get` read straight after, which would return that
   * unchanged terminal row and be mistaken for a successful cancellation — is
   * what decides whether {@link onTaskCanceled} runs at all.
   */
  private async markCanceled(
    taskId: string,
    task?: Task
  ): Promise<PlainTask | null> {
    const canceled = task
      ? this.db.tasks.save(task) && this.db.tasks.get(taskId)
      : this.db.tasks.cancel(taskId);
    if (!canceled) return null;
    await this.onTaskCanceled(taskId);
    return canceled;
  }

  /**
   * Interrupt work still in flight for a task that has just been canceled.
   *
   * Default: nothing, which is right for an agent whose turn is a single
   * inference — the row is terminal and the next guarded write refuses. An agent
   * with children overrides this to abort them.
   *
   * **Must be best-effort.** Cancellation has already been recorded by the time
   * this runs, and it must not fail because cleanup did.
   */
  protected async onTaskCanceled(_taskId: string): Promise<void> {}
}
