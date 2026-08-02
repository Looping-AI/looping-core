/**
 * The shapes of everything an agent tunes, plus a working set of defaults.
 *
 * In the predecessor repos this file held bare `export const`s that ~12 modules
 * imported directly. That is what this package cannot do: a module-level constant
 * read at import time is not overridable by a consumer, and it freezes the value
 * into the module graph before `env` exists. So core owns the *shapes* and a
 * baseline; a consuming agent passes overrides to {@link resolveConfig} once, at
 * DO start, and the resolved object is threaded through explicitly.
 *
 * The distinction against {@link file://./platform.ts} stays sharp: nothing here
 * is a platform fact, and nothing there is tunable.
 */

/** Model ids and per-call generation settings. */
export interface ModelConfig {
  /** Workers AI model for the tool loop. Must support function calling. */
  chatModelId: string;
  /**
   * Tried when the primary throws. Should be a *different vendor and family* —
   * a same-family fallback shares the failure mode you are falling back from.
   */
  fallbackChatModelId: string;
  /** AI Gateway slug; `"default"` auto-provisions on first request. */
  aiGatewayId: string;
  /**
   * Output-token ceiling for every chat call. Left unset, the binding applies a
   * per-model default which a reasoning model spends on `reasoning_content`
   * before emitting the tool call — a truncated round that reads as a clean
   * answer. Generous on purpose: it bounds a runaway, it does not ration.
   */
  maxOutputTokens: number;
  /** Reasoning budget forwarded on the binding's `inputs` by workers-ai-provider. */
  reasoningEffort: "low" | "medium" | "high";
}

/**
 * An execution budget, in the only two currencies that mean anything: **turns**
 * (what it costs) and **wall clock** (how long it can run away for).
 *
 * Rounds, chunks and steps are *mechanics*, not budgets — a round is the
 * delegate/answer loop, a chunk is a durable slice sized by the Workers step
 * timeout. None of them is tunable and none belongs here. Conflating the two is
 * what once made an overnight runaway look healthy to every cap in the system.
 *
 * Reaching either ceiling does the same thing at either level: one final call
 * with **no tools** — "you have spent your budget, answer now from what you
 * have". A ceiling yields an answer; it never drops the work.
 */
export interface AgentLimits {
  /**
   * Tool-loop steps, summed across every round *and* across the
   * primary→fallback attempt within a round — a fallback attempt is real spend.
   */
  maxTurns: number;
  /**
   * Measured from the first durable step. Note for whoever implements
   * escalation: this must be **rebased** after a `step.waitForEvent(...)`
   * returns, or a human's thinking time is charged to the agent and a task that
   * asks a question at minute 5 is dead before the answer arrives. Turns need no
   * such care — waiting costs none.
   */
  maxWallMs: number;
}

/** Session memory + compaction tuning. */
export interface SessionConfig {
  /** Soft cap (tokens) for the self-edited `"memory"` scratchpad block. */
  memoryMaxTokens: number;
  /** Live-history token threshold that triggers automatic compaction. */
  compactAfterTokens: number;
  /**
   * Tokens of the most recent history compaction keeps **verbatim**.
   *
   * Read this together with {@link compactAfterTokens}; neither means anything
   * alone. After a compaction the floor is `system + protectHead + summary +
   * tail`, so the conversation that must accumulate before compaction fires
   * again is `Δ = compactAfterTokens − floor`, and the SDK sizes each summary at
   * 20% of the middle it folded, so at equilibrium `S ≈ 0.2Δ`.
   *
   * INVARIANT: `compactAfterTokens − compactTailTokens >= 10_000`, asserted in
   * `session.spec.ts`. Below it the fixed floor eats the gap and compaction
   * fires on nearly every append, each firing spending a summarizer call on a
   * near-empty middle. Never lower the threshold without lowering the tail too.
   */
  compactTailTokens: number;
  /** One-line description shown to the model for the writable `"memory"` block. */
  memoryDescription: string;
}

export interface CoreConfig {
  model: ModelConfig;
  /** What bounds the MAIN agent across every round of one task. */
  mainAgentLimits: AgentLimits;
  /**
   * The baseline every subagent branch runs under. A recipe may override either
   * field — to any positive integer, larger included — and inherits the baseline
   * for whatever it does not validly declare. A default, not a ceiling.
   */
  subagentLimits: AgentLimits;
  /**
   * How many of the most recent assistant turns keep their tool **results** in a
   * subagent's rolling window. Older results are stubbed; the tool *calls* and
   * the model's own text always survive the full `historyWindow`, because that
   * is where a recipe's model keeps whatever it wrote down for itself.
   *
   * A mechanic of the window, not a property of a domain — which is why it is
   * deliberately not a recipe field: recipe fields are fingerprinted, and
   * changing a fingerprint strands every in-flight run behind a mismatch that
   * costs it its whole history.
   */
  toolOutputWindow: number;
  /**
   * Upper bound on subtasks per **round** — a core invariant: a delegating round
   * emits `1..maxSubtasks` subtasks, which is also what bounds its fan-out (all
   * dependency-ready subtasks run concurrently, with no other concurrency cap).
   *
   * Not a budget but a shape: it is what the delegation schema offers the model,
   * and the data layer re-checks it as the durable guard.
   */
  maxSubtasks: number;
  session: SessionConfig;
}

/**
 * A working baseline. Every value is overridable; none is a ceiling. These are
 * the values both predecessor agents converged on in production, so they are a
 * reasonable place to start rather than an opinion about your domain.
 */
export const DEFAULT_CORE_CONFIG: CoreConfig = {
  model: {
    chatModelId: "@cf/zai-org/glm-5.2",
    fallbackChatModelId: "@cf/moonshotai/kimi-k2.7-code",
    aiGatewayId: "default",
    maxOutputTokens: 16_384,
    reasoningEffort: "medium"
  },
  mainAgentLimits: { maxTurns: 20, maxWallMs: 60 * 60_000 },
  subagentLimits: { maxTurns: 20, maxWallMs: 30 * 60_000 },
  toolOutputWindow: 4,
  maxSubtasks: 8,
  session: {
    memoryMaxTokens: 1200,
    compactAfterTokens: 16_000,
    compactTailTokens: 5_000,
    memoryDescription:
      "Durable facts worth remembering across all of this caller's conversations — " +
      "stable preferences, decisions, people, and context. Keep it concise."
  }
};

/** One level of optionality per nested group — enough for a config this shallow. */
export type CoreConfigOverrides = {
  [K in keyof CoreConfig]?: CoreConfig[K] extends object
    ? Partial<CoreConfig[K]>
    : CoreConfig[K];
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Merge overrides onto {@link DEFAULT_CORE_CONFIG} and check the invariants that
 * are cheap to get wrong and expensive to notice.
 *
 * Called once, at DO start, and the result threaded explicitly from there. Do
 * not call it per-request: the point of resolving is that every module downstream
 * reads the same object.
 */
export function resolveConfig(overrides: CoreConfigOverrides = {}): CoreConfig {
  const config: CoreConfig = {
    model: { ...DEFAULT_CORE_CONFIG.model, ...overrides.model },
    mainAgentLimits: {
      ...DEFAULT_CORE_CONFIG.mainAgentLimits,
      ...overrides.mainAgentLimits
    },
    subagentLimits: {
      ...DEFAULT_CORE_CONFIG.subagentLimits,
      ...overrides.subagentLimits
    },
    toolOutputWindow:
      overrides.toolOutputWindow ?? DEFAULT_CORE_CONFIG.toolOutputWindow,
    maxSubtasks: overrides.maxSubtasks ?? DEFAULT_CORE_CONFIG.maxSubtasks,
    session: { ...DEFAULT_CORE_CONFIG.session, ...overrides.session }
  };

  const positive = (value: number, name: string): void => {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ConfigError(`${name} must be a positive number, got ${value}`);
    }
  };

  positive(config.mainAgentLimits.maxTurns, "mainAgentLimits.maxTurns");
  positive(config.mainAgentLimits.maxWallMs, "mainAgentLimits.maxWallMs");
  positive(config.subagentLimits.maxTurns, "subagentLimits.maxTurns");
  positive(config.subagentLimits.maxWallMs, "subagentLimits.maxWallMs");
  positive(config.toolOutputWindow, "toolOutputWindow");
  positive(config.maxSubtasks, "maxSubtasks");
  positive(config.model.maxOutputTokens, "model.maxOutputTokens");

  // See SessionConfig.compactTailTokens — below this gap the fixed floor eats
  // the headroom and compaction fires on nearly every append.
  const headroom =
    config.session.compactAfterTokens - config.session.compactTailTokens;
  if (headroom < 10_000) {
    throw new ConfigError(
      `session.compactAfterTokens - session.compactTailTokens must be >= 10000, got ${headroom}. ` +
        "Lower compactTailTokens along with compactAfterTokens."
    );
  }

  return config;
}
