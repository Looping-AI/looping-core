import { describe, it, expect, expectTypeOf } from "vitest";
import { validateRecipe, type RecipePolicy } from "./validation.js";
import type { ResolvedRecipe, ValidatedRecipe } from "./recipe.js";
import { TEST_MODELS } from "../testing/fixtures.js";

/**
 * Which model a recipe runs on, and who gets to decide.
 *
 * A recipe *declares an optional preference*; a validated recipe *has a model*.
 * The gap between those two sentences is the whole design, and it is enforced by
 * the types rather than by a convention: `ResolvedRecipe.primaryModelId` is
 * `string | undefined`, `ValidatedRecipe.primaryModelId` is `string`, so a model
 * id can only be read off a recipe that has been through here.
 *
 * The alternative — which shipped briefly in `@loopingai/plugins` — was a
 * `""` sentinel meaning "no preference". It worked, because an empty string is
 * never in the allowlist and gets substituted like any other unknown id. But
 * nothing in the type said so: `""` was indistinguishable from a real id, from
 * a typo, and from a genuine mistake, and it would have reached Workers AI
 * verbatim if the substitution had ever been bypassed.
 */

const policy: RecipePolicy = {
  modelAllowlist: new Set([
    TEST_MODELS.chatModelId,
    TEST_MODELS.fallbackChatModelId
  ]),
  defaultPrimaryModelId: TEST_MODELS.chatModelId,
  defaultFallbackModelId: TEST_MODELS.fallbackChatModelId,
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

describe("a recipe that names no model", () => {
  it("compiles — omission is the way to say 'the host's'", () => {
    // The fixture above sets neither id. That this typechecks *is* an
    // assertion: a published plugin must be able to declare a recipe without
    // naming a model, because it has no idea what its host is billed for.
    const validated = validateRecipe(recipe(), policy);

    expect(validated.primaryModelId).toBe(TEST_MODELS.chatModelId);
    expect(validated.fallbackModelId).toBe(TEST_MODELS.fallbackChatModelId);
  });

  it("never yields an empty id", () => {
    // The failure the `""` sentinel could produce if substitution were ever
    // bypassed: an empty model id reaching the binding, which fails on the call
    // with an error naming nothing useful.
    const validated = validateRecipe(recipe(), policy);
    expect(validated.primaryModelId).not.toBe("");
    expect(validated.fallbackModelId).not.toBe("");
  });
});

describe("a recipe that states a preference", () => {
  it("keeps an id the host allows", () => {
    // Naming one is legitimate for a *host-owned* recipe: a long sequence of
    // cheap decisions is not the same workload as conversation.
    const validated = validateRecipe(
      recipe({
        primaryModelId: TEST_MODELS.fallbackChatModelId,
        fallbackModelId: TEST_MODELS.chatModelId
      }),
      policy
    );

    expect(validated.primaryModelId).toBe(TEST_MODELS.fallbackChatModelId);
    expect(validated.fallbackModelId).toBe(TEST_MODELS.chatModelId);
  });

  it("substitutes the host's own for an id it does not allow", () => {
    // A preference, not a demand. An agent running on a different pair gets its
    // own models rather than a validation error — which is what lets a plugin
    // ship a recipe at all.
    const validated = validateRecipe(
      recipe({
        primaryModelId: "@cf/some/model-this-host-does-not-run",
        fallbackModelId: "@cf/another/one"
      }),
      policy
    );

    expect(validated.primaryModelId).toBe(policy.defaultPrimaryModelId);
    expect(validated.fallbackModelId).toBe(policy.defaultFallbackModelId);
  });

  it("substitutes each slot independently", () => {
    // A recipe that knows what it wants for one slot and not the other is a
    // real case; resolving both together would silently discard the half that
    // was valid.
    const validated = validateRecipe(
      recipe({ primaryModelId: TEST_MODELS.fallbackChatModelId }),
      policy
    );

    expect(validated.primaryModelId).toBe(TEST_MODELS.fallbackChatModelId);
    expect(validated.fallbackModelId).toBe(policy.defaultFallbackModelId);
  });

  it("treats an empty string as no preference, not as a model", () => {
    // Belt and braces for the sentinel that used to ship: `""` is not in any
    // allowlist, so it resolves like any other unknown id rather than reaching
    // a binding.
    const validated = validateRecipe(
      recipe({ primaryModelId: "", fallbackModelId: "" }),
      policy
    );

    expect(validated.primaryModelId).toBe(policy.defaultPrimaryModelId);
    expect(validated.fallbackModelId).toBe(policy.defaultFallbackModelId);
  });
});

describe("the compile-time guarantee", () => {
  it("makes a declared recipe's model optional and a validated one's required", () => {
    // This is what stops the next `""` sentinel from being invented. Reading
    // `primaryModelId` off an unvalidated recipe yields `string | undefined`
    // and fails to compile where a model is expected; only `validateRecipe` can
    // produce the narrowed shape.
    expectTypeOf<ResolvedRecipe["primaryModelId"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<ResolvedRecipe["fallbackModelId"]>().toEqualTypeOf<
      string | undefined
    >();

    expectTypeOf<ValidatedRecipe["primaryModelId"]>().toEqualTypeOf<string>();
    expectTypeOf<ValidatedRecipe["fallbackModelId"]>().toEqualTypeOf<string>();
  });

  it("returns a shape assignable wherever a model id is required", () => {
    const validated: ValidatedRecipe = validateRecipe(recipe(), policy);
    const primary: string = validated.primaryModelId;
    const fallback: string = validated.fallbackModelId;

    expect(primary).toBeTruthy();
    expect(fallback).toBeTruthy();
  });
});
