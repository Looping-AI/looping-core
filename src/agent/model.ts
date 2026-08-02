import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import type { ModelConfig } from "../config.js";

/**
 * The Workers-AI model pair every loop runs on, built per agent instance.
 *
 * The predecessor read `env.AI` and five config constants as module-level
 * imports. Neither survives packaging: `env` does not exist at module scope on
 * Workers, and a module constant cannot be overridden by a consumer. So this is
 * a factory over an injected binding and an injected {@link ModelConfig}.
 */

/**
 * Custom metadata attached to the AI Gateway log for every call a pair makes.
 * The gateway's own `metadata` is otherwise `null`, so a model call can only be
 * tied back to its task by timestamp; stamping `{ taskId, round }` (a turn) or
 * `{ taskId, subtaskId }` (a chunk) makes correlation exact. Values are limited
 * to the gateway's accepted scalar set.
 */
export type GatewayMetadata = Record<string, number | string | boolean>;

export interface ModelOverrides {
  /** Test override for the primary slot. */
  model?: LanguageModel;
  /** Test override for the fallback slot. */
  fallbackModel?: LanguageModel;
  /**
   * Workers-AI id for the primary slot (a recipe's, already code-validated
   * against the allowlist by `validateRecipe`). Defaults to the configured
   * `chatModelId`.
   */
  primaryModelId?: string;
  /**
   * Workers-AI id for the fallback slot (already code-validated). Defaults to
   * the configured `fallbackChatModelId`.
   */
  fallbackModelId?: string;
  /** AI Gateway log metadata for correlation — see {@link GatewayMetadata}. */
  metadata?: GatewayMetadata;
}

/** The primary/fallback models (lazily memoized) plus their ids for logging. */
export interface ModelPair {
  primary: () => LanguageModel;
  fallback: () => LanguageModel;
  primaryId: () => string;
  fallbackId: () => string;
}

export interface ModelRuntime {
  /**
   * Lazily build + memoize a primary/fallback model pair (overridable in tests,
   * id-parameterized for recipes). No allowlisting happens here —
   * `validateRecipe` is the single validation owner for recipe-supplied ids.
   */
  createModelPair(overrides?: ModelOverrides): ModelPair;
}

export interface ModelRuntimeDeps {
  /** The `AI` binding. Read lazily — see {@link createModelRuntime}. */
  ai: Ai;
  config: ModelConfig;
}

/**
 * Build the model runtime for one agent instance.
 *
 * The provider is constructed on first *use*, not here. During `wrangler deploy`
 * Cloudflare evaluates module scope to validate the new version, and bindings
 * are not populated at that point — constructing eagerly makes `createWorkersAI`
 * throw "you must provide either a binding or credentials". The same laziness
 * protects a consumer who builds their runtime early.
 */
export function createModelRuntime(deps: ModelRuntimeDeps): ModelRuntime {
  const { config } = deps;
  let provider: ReturnType<typeof createWorkersAI> | undefined;
  const workersai = () =>
    (provider ??= createWorkersAI({
      binding: deps.ai,
      gateway: { id: config.aiGatewayId }
    }));

  /**
   * Per-model Workers-AI settings: pin the gateway id (so per-call metadata does
   * not drop the gateway route), attach correlation metadata when supplied, and
   * set the reasoning budget.
   *
   * Always returns a settings object, even with no metadata: `reasoning_effort`
   * has to reach the binding on every call, and an `undefined` return drops it.
   */
  const chatSettings = (metadata?: GatewayMetadata) => ({
    gateway: { id: config.aiGatewayId, ...(metadata ? { metadata } : {}) },
    reasoning_effort: config.reasoningEffort
  });

  return {
    createModelPair(overrides: ModelOverrides = {}): ModelPair {
      const primaryId = overrides.primaryModelId ?? config.chatModelId;
      const fallbackId =
        overrides.fallbackModelId ?? config.fallbackChatModelId;
      let primary: LanguageModel | undefined;
      let fallback: LanguageModel | undefined;
      const settings = chatSettings(overrides.metadata);
      return {
        primary: () =>
          (primary ??= overrides.model ?? workersai()(primaryId, settings)),
        fallback: () =>
          (fallback ??=
            overrides.fallbackModel ??
            overrides.model ??
            workersai()(fallbackId, settings)),
        primaryId: () => primaryId,
        fallbackId: () => fallbackId
      };
    }
  };
}
