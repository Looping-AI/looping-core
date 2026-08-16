import { describe, it, expect, expectTypeOf } from "vitest";
import { validateRecipe, type RecipePolicy } from "./validation.js";
import type { ResolvedRecipe, ValidatedRecipe } from "./recipe.js";
import { TEST_MODELS } from "../testing/fixtures.js";

/**
 * Which model a recipe runs on, and who decides.
 *
 * The answer is: the agent, in its config, and nothing else. A recipe describes
 * *what work is* — soul, tools, budget, context window — and has no field to
 * name a model with.
 *
 * A recipe stating its own model was tried once and removed — see
 * `validation.ts` for what it cost. What matters here is that both failure
 * modes are now **unrepresentable rather than guarded**, which is why the tests
 * below are mostly about shapes rather than substitutions.
 */

const policy: RecipePolicy = {
  primaryModelId: TEST_MODELS.chatModelId,
  fallbackModelId: TEST_MODELS.fallbackChatModelId,
  knownToolFamilies: new Set(["known"]),
  baselineLimits: { maxTurns: 20, maxWallMs: 60_000 }
};

const recipe = (overrides: Partial<ResolvedRecipe> = {}): ResolvedRecipe => ({
  key: "sample",
  version: 1,
  soul: "You are a sample subagent.",
  toolFamilies: [],
  enabled: true,
  limits: {},
  historyWindow: 10,
  reportMetrics: false,
  ...overrides
});

describe("the model pair a recipe runs on", () => {
  it("is the host's, copied", () => {
    const validated = validateRecipe(recipe(), policy);

    expect(validated.primaryModelId).toBe(policy.primaryModelId);
    expect(validated.fallbackModelId).toBe(policy.fallbackModelId);
  });

  it("stays distinct, so the fallback is never a retry of the primary", () => {
    // The defect that removed the preference mechanism. With the pair copied
    // wholesale there is no path to a collision — `resolveConfig` already
    // refuses a config whose two models are the same, so this holds for every
    // recipe by construction rather than per recipe.
    const validated = validateRecipe(recipe(), policy);

    expect(validated.primaryModelId).not.toBe(validated.fallbackModelId);
  });

  it("is unaffected by anything a recipe carries", () => {
    // A recipe is data. Even one that arrived from a database with extra keys
    // on it cannot influence which model runs it: the two fields are assigned
    // after the spread, from the policy.
    const smuggled = {
      ...recipe(),
      primaryModelId: "@cf/attacker/model",
      fallbackModelId: "@cf/attacker/model"
    } as ResolvedRecipe;

    const validated = validateRecipe(smuggled, policy);

    expect(validated.primaryModelId).toBe(policy.primaryModelId);
    expect(validated.fallbackModelId).toBe(policy.fallbackModelId);
  });

  it("is never empty", () => {
    // Guaranteed upstream: `resolveConfig` refuses an empty id, so the policy
    // cannot carry one to copy.
    const validated = validateRecipe(recipe(), policy);

    expect(validated.primaryModelId).not.toBe("");
    expect(validated.fallbackModelId).not.toBe("");
  });
});

describe("the shapes", () => {
  it("gives a declared recipe no way to name a model at all", () => {
    // Stronger than optional. A field that can be *set* is a field someone will
    // set — the `""` sentinel and the colliding preference were both invented
    // to fill one. Absence of the field is what makes them unwritable.
    expectTypeOf<ResolvedRecipe>().not.toHaveProperty("primaryModelId");
    expectTypeOf<ResolvedRecipe>().not.toHaveProperty("fallbackModelId");
  });

  it("gives a validated recipe both, required", () => {
    // A runner needs a pair, and this is the only type that has one — so the
    // only way to hold a model id is to have been through `validateRecipe`.
    expectTypeOf<ValidatedRecipe["primaryModelId"]>().toEqualTypeOf<string>();
    expectTypeOf<ValidatedRecipe["fallbackModelId"]>().toEqualTypeOf<string>();

    const validated: ValidatedRecipe = validateRecipe(recipe(), policy);
    const primary: string = validated.primaryModelId;
    expect(primary).toBeTruthy();
  });
});

describe("what validation still does police", () => {
  it("drops tool families the host has not installed", () => {
    // Unlike models, this one is a real capability boundary: the legal set is
    // whatever the installed plugins registered, which genuinely varies.
    const validated = validateRecipe(
      recipe({ toolFamilies: ["known", "not-installed", "known"] }),
      policy
    );

    expect(validated.toolFamilies).toEqual(["known"]);
  });

  it("merges limits over the baseline rather than replacing it", () => {
    const validated = validateRecipe(
      recipe({ limits: { maxTurns: 39 } }),
      policy
    );

    expect(validated.limits.maxTurns).toBe(39);
    expect(validated.limits.maxWallMs).toBe(policy.baselineLimits.maxWallMs);
  });
});
