import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import type { SessionMessage } from "agents/experimental/memory/session";
import { createAgentRuntime, RuntimeSetupError } from "./index.js";
import { deterministicSessionMessage } from "../agent/history.js";
import { buildRecipeTools, collectToolFamilies } from "./tool-families.js";
import {
  definePlugin,
  PLUGIN_CONTRACT_VERSION,
  type AgentPlugin,
  type ToolFamilyContext
} from "../contract/plugin.js";
import { DEFAULT_CORE_CONFIG } from "../config.js";
import type { ResolvedRecipe, SubtaskTypeSpec } from "../contract/recipe.js";

/**
 * `createAgentRuntime` is the load-bearing refactor this package exists for: the
 * predecessor resolved its recipe registry, tool-family map and delegate schema
 * at *module import*, which froze them before `env` exists and pulled every
 * domain into every bundle. Everything that used to be a module constant is now
 * a field on an object built once per DO instance.
 *
 * These specs cover the part a plugin author feels: what the runtime refuses at
 * startup, and what it composes when the plugins agree.
 */

const recipe = (key: string): ResolvedRecipe => ({
  key,
  version: 1,
  primaryModelId: DEFAULT_CORE_CONFIG.model.chatModelId,
  fallbackModelId: DEFAULT_CORE_CONFIG.model.fallbackChatModelId,
  soul: `You are the ${key} subagent.`,
  toolFamilies: [],
  enabled: true,
  limits: {},
  historyWindow: 10,
  reportMetrics: false
});

const subtaskType = (key: string): SubtaskTypeSpec => ({
  key,
  description: `does ${key} things`,
  params: z.object({ targetId: z.string().describe("the thing to act on") }),
  capability: `You can delegate ${key} work.`,
  recipe: recipe(key)
});

const noopFamily = (name: string) => () => ({
  tools: { [name]: tool({ description: name, inputSchema: z.object({}) }) }
});

describe("createAgentRuntime — what it refuses at startup", () => {
  it("refuses two plugins claiming the same key", () => {
    const a = definePlugin({ key: "dup" });
    const b = definePlugin({ key: "dup" });

    expect(() => createAgentRuntime({ plugins: [a, b] })).toThrow(
      RuntimeSetupError
    );
    expect(() => createAgentRuntime({ plugins: [a, b] })).toThrow(/dup/);
  });

  it("refuses a plugin built against a different contract version", () => {
    // The three-repo publish train's failure mode: core and plugins ship from
    // separate repos, so one can lag. This must fail at DO start, naming both
    // versions, rather than as a structural-type mismatch several frames away.
    const stale: AgentPlugin = {
      key: "stale",
      contractVersion: PLUGIN_CONTRACT_VERSION + 1
    };

    expect(() => createAgentRuntime({ plugins: [stale] })).toThrow(
      /contract v|speaks v/
    );
  });

  it("refuses two plugins registering the same tool family", () => {
    const a = definePlugin({
      key: "a",
      toolFamilies: { shared: noopFamily("one") }
    });
    const b = definePlugin({
      key: "b",
      toolFamilies: { shared: noopFamily("two") }
    });

    expect(() => createAgentRuntime({ plugins: [a, b] })).toThrow(
      /"shared".*"a".*"b"/s
    );
  });

  it("refuses a missing binding only when env is supplied to check against", () => {
    const needsKey = definePlugin({
      key: "needy",
      requires: { secrets: ["SOME_API_KEY"] }
    });

    // Core cannot know which of a consumer's bindings are optional, so the
    // check is opt-in.
    expect(() => createAgentRuntime({ plugins: [needsKey] })).not.toThrow();

    expect(() => createAgentRuntime({ plugins: [needsKey], env: {} })).toThrow(
      /SOME_API_KEY.*needy/s
    );

    // An empty string is a missing secret, not a present one — this is the
    // shape a `wrangler secret` that was never set actually takes.
    expect(() =>
      createAgentRuntime({ plugins: [needsKey], env: { SOME_API_KEY: "" } })
    ).toThrow(/SOME_API_KEY/);

    expect(() =>
      createAgentRuntime({ plugins: [needsKey], env: { SOME_API_KEY: "sk-1" } })
    ).not.toThrow();
  });
});

describe("createAgentRuntime — what it composes", () => {
  const alpha = definePlugin({
    key: "alpha",
    subtaskType: subtaskType("alpha"),
    toolFamilies: { alphaTools: noopFamily("alphaTool") },
    capability: "Alpha capability block.",
    mainAgentTools: () => ({
      alphaLookup: tool({ description: "lookup", inputSchema: z.object({}) })
    }),
    store: { plugin: "alpha", version: 1, ensureTables: () => {} }
  });

  const beta = definePlugin({
    key: "beta",
    subtaskType: subtaskType("beta"),
    capability: "Beta capability block."
  });

  it("builds the type registry, family map and stores from the plugin list", () => {
    const rt = createAgentRuntime({ plugins: [alpha, beta] });

    expect(rt.types.keys).toEqual(["alpha", "beta"]);
    expect([...rt.toolFamilies.keys()]).toEqual(["alphaTools"]);
    expect(rt.stores.map((s) => s.plugin)).toEqual(["alpha"]);
    expect(rt.plugins).toHaveLength(2);
  });

  it("derives the recipe policy's legal tool families from what is installed", () => {
    // The predecessor hardcoded `KNOWN_TOOL_FAMILIES` as a literal Set naming
    // three families, one of them a domain's. The legal set is now exactly what
    // the installed plugins registered.
    const rt = createAgentRuntime({ plugins: [alpha, beta] });

    expect([...rt.policy.knownToolFamilies]).toEqual(["alphaTools"]);
    expect(
      rt.policy.modelAllowlist.has(DEFAULT_CORE_CONFIG.model.chatModelId)
    ).toBe(true);
  });

  it("routes lifecycle hooks to the plugin owning the subtask type", async () => {
    const withHooks = definePlugin<{ leased?: string }>({
      key: "leases",
      subtaskType: subtaskType("leased-work"),
      resolveRuntime: async () => ({ leased: "resource-1" }),
      enrichResult: async (_ctx, result) => ({ ...result, enriched: true })
    });

    const rt = createAgentRuntime({ plugins: [withHooks, beta] });
    const ctx = {
      taskId: "t1",
      subtaskId: 1,
      type: "leased-work",
      params: {},
      toolFamilies: []
    };

    expect(rt.pluginForType("leased-work")?.key).toBe("leases");
    expect(await rt.resolveRuntime(ctx)).toEqual({ leased: "resource-1" });

    // A type whose plugin declares no hook gets the neutral value, not a throw.
    expect(await rt.resolveRuntime({ ...ctx, type: "beta" })).toEqual({});
    // …and neither does a type no plugin owns at all.
    expect(await rt.resolveRuntime({ ...ctx, type: "nobody" })).toEqual({});
    await expect(
      rt.onAbort({ ...ctx, type: "nobody" })
    ).resolves.toBeUndefined();
  });

  it("merges main-agent tools and capability blocks across plugins", () => {
    const rt = createAgentRuntime({ plugins: [alpha, beta] });

    expect(Object.keys(rt.mainAgentTools())).toEqual(["alphaLookup"]);
    expect(rt.renderCapabilities()).toBe(
      "Alpha capability block.\n\nBeta capability block."
    );
  });

  it("returns an empty capability string when no plugin declares one", () => {
    // Named because it is what lets a call site append unconditionally instead
    // of emitting a separator around nothing.
    const rt = createAgentRuntime({ plugins: [definePlugin({ key: "bare" })] });
    expect(rt.renderCapabilities()).toBe("");
  });

  describe("onMessagesDisplaced", () => {
    // Compaction is lossy and core is what performs it, so the announcement is
    // core's to make. What a plugin does with the messages is its own business.
    const displaced: SessionMessage[] = [
      deterministicSessionMessage("m1", "user", "one"),
      deterministicSessionMessage("m2", "assistant", "two")
    ];

    it("fans out to every plugin declaring the hook", async () => {
      const seen: Record<string, string[]> = {};
      const listener = (key: string) =>
        definePlugin({
          key,
          onMessagesDisplaced: async (messages) => {
            seen[key] = messages.map((m) => m.id);
          }
        });

      const rt = createAgentRuntime({
        plugins: [listener("one"), beta, listener("two")]
      });
      await rt.onMessagesDisplaced(displaced);

      expect(seen).toEqual({ one: ["m1", "m2"], two: ["m1", "m2"] });
    });

    it("still delivers to the others when one plugin rejects", async () => {
      // The `allSettled` property. A `Promise.all` here fails this twice over:
      // it rejects the aggregate at the first throw, and it stops awaiting the
      // rest — so the healthy plugin's write is still in flight when the
      // wrapper returns, and on a DO the isolate can be evicted before it
      // lands. The healthy listener defers past a macrotask precisely so this
      // test can tell the two apart.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      let delivered: string[] = [];

      const rt = createAgentRuntime({
        plugins: [
          definePlugin({
            key: "broken",
            onMessagesDisplaced: async () => {
              throw new Error("store unavailable");
            }
          }),
          definePlugin({
            key: "healthy",
            onMessagesDisplaced: async (messages) => {
              await new Promise((resolve) => setTimeout(resolve, 0));
              delivered = messages.map((m) => m.id);
            }
          })
        ]
      });

      await expect(rt.onMessagesDisplaced(displaced)).resolves.toBeUndefined();
      expect(delivered).toEqual(["m1", "m2"]);

      // Logged against the key that caused it — an anonymous aggregate is not
      // debuggable across installed plugins.
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0][0]).toContain("broken");
      errors.mockRestore();
    });

    it("resolves cleanly when no plugin declares it", async () => {
      const rt = createAgentRuntime({ plugins: [alpha, beta] });
      await expect(rt.onMessagesDisplaced(displaced)).resolves.toBeUndefined();
    });
  });

  it("applies config overrides over the defaults", () => {
    const rt = createAgentRuntime({
      plugins: [],
      config: { maxSubtasks: 3, model: { chatModelId: "@cf/custom/model" } }
    });

    expect(rt.config.maxSubtasks).toBe(3);
    expect(rt.config.model.chatModelId).toBe("@cf/custom/model");
    // Untouched groups still come from the baseline.
    expect(rt.config.subagentLimits).toEqual(
      DEFAULT_CORE_CONFIG.subagentLimits
    );
  });
});

describe("buildRecipeTools", () => {
  const ctx = {} as ToolFamilyContext;

  it("merges the named families and reports names nobody registered", () => {
    const registry = collectToolFamilies([
      { key: "p", toolFamilies: { one: noopFamily("toolOne") } }
    ]);

    const built = buildRecipeTools(["one", "missing"], registry, ctx);

    expect(Object.keys(built.tools)).toEqual(["toolOne"]);
    // Skipped rather than thrown: a subagent running with fewer tools degrades
    // better than a whole branch failing, and the caller can log the names.
    expect(built.skipped).toEqual(["missing"]);
  });

  it("composes every family's abort hook into one", async () => {
    const ran: string[] = [];
    const family = (name: string) => () => ({
      tools: {},
      abort: async () => {
        ran.push(name);
      }
    });
    const registry = collectToolFamilies([
      { key: "p", toolFamilies: { a: family("a"), b: family("b") } }
    ]);

    const built = buildRecipeTools(["a", "b"], registry, ctx);
    await built.abort?.(ctx);

    expect(ran).toEqual(["a", "b"]);
  });

  it("leaves abort undefined when no family declared one", () => {
    const registry = collectToolFamilies([
      { key: "p", toolFamilies: { plain: noopFamily("t") } }
    ]);

    expect(buildRecipeTools(["plain"], registry, ctx).abort).toBeUndefined();
  });
});
