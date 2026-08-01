import { z } from "zod";
import type { ReferenceCatalogEntry } from "./catalog.js";
import {
  SubtaskParamsError,
  type SubtaskTypeRegistry
} from "./subtask-types.js";
import type {
  DecompositionProposal,
  SubtaskDraft,
  SubtaskReference
} from "./types.js";

/**
 * Pure validation and resolution of a `delegate` call's input. No model, no
 * Session, no database — given a {@link DecompositionProposal} and the ephemeral
 * reference catalog it was generated against, this either produces the drafts to
 * persist or throws.
 *
 * Two invariants live here:
 *
 * - **The model selects references by index only.** It emits catalog indices; this
 *   module copies the catalog entry's exact role+text onto the draft. Model output
 *   never becomes reference text, so a Subtask cannot carry a rewritten,
 *   summarized, or fabricated "quote" of the conversation.
 * - **The dependency graph is a validated DAG.** Unknown, duplicate,
 *   self-referential, and cyclic edges are all rejected here. The data layer's
 *   `createDecomposition` re-checks the cheap structural rules as a storage guard,
 *   but full cycle detection is this module's job.
 *
 * Invalid output is never repaired: a throw fails the attempt, which falls back to
 * the other model, and two failed attempts fail the parent Task. Silently
 * synthesizing a general Subtask would deliver plausible work the user never asked
 * for.
 */

/** A model proposal that cannot be resolved into a valid decomposition. */
export class DecompositionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecompositionValidationError";
  }
}

/**
 * A required string that is not whitespace.
 *
 * Written as a `.regex()` rather than the equivalent `.refine()`, deliberately.
 * Both are enforced wherever this schema is actually run, but a refinement is
 * **invisible to the model**: custom checks do not survive JSON-Schema conversion,
 * so the rule would be one the model is held to without ever being shown it.
 * `/\S/` converts to `"pattern": "\\S"` next to `"minLength": 1`, so the
 * constraint reaches the model as part of the tool schema, on every field, with
 * no per-field `.describe()` needed to restate it.
 *
 * Being shown a rule is not the same as being held to it, and the difference used
 * to be a hole. This schema reaches the model through a **control** tool, which has
 * no `execute` — so the SDK's input validation never ran on it, and a blank value
 * the model was shown the pattern for sailed through anyway. What enforces it is
 * {@link file://../control.ts control.ts}, which parses every control call with its
 * own schema before the round uses it.
 */
export const nonBlank = (label: string) =>
  z
    .string()
    .min(1)
    .regex(/\S/, { message: `${label} must not be blank` });

function makeSubtaskProposalSchema(types: SubtaskTypeRegistry) {
  return z.object({
    localKey: nonBlank("localKey"),
    // A closed enum, not prose: an invented type is rejected by the tool schema
    // itself rather than silently resolving to some default recipe.
    type: z.enum(types.enumKeys()),
    prompt: nonBlank("prompt"),
    referenceIndexes: z.array(z.number().int().min(1)).optional(),
    dependsOn: z.array(nonBlank("dependsOn entry")),
    /**
     * The type's required inputs — ids the model quotes from a tool result.
     * Every key any type declares is named here, gathered from those types by
     * `SubtaskTypeRegistry.paramProperties`; which of them a given type actually
     * *requires* is the per-type contract, checked below.
     *
     * Named keys rather than a free-form record, deliberately: a record's value
     * schema is the JSON Schema `additionalProperties` slot, which the AI SDK's
     * strict-mode pass overwrites with `false` — turning "any string key" into
     * "no key at all" and leaving the model no legal way to send params it was
     * told to send. Explicit properties survive that pass, and say more besides.
     */
    params: z.object(types.paramProperties()).optional()
  });
}

/**
 * The `delegate` tool's input schema. The per-round bound is enforced here
 * (the model is told it, and the SDK rejects a call that breaks it) and again in
 * the data layer, which owns the durable invariant.
 *
 * Blank strings are rejected at the schema edge rather than deep in execution: an
 * empty `prompt` would otherwise burn a Subtask slot and only fail later, inside
 * the child, with no useful diagnostic.
 *
 * `referenceIndexes` is optional because this one schema also has to describe the
 * calls **reconstructed from durable rows** in later rounds, whose references
 * were resolved to verbatim snapshots at the time and no longer have indices.
 */
export function makeDecompositionProposalSchema(
  types: SubtaskTypeRegistry,
  maxSubtasks: number
) {
  return z.object({
    reply: nonBlank("reply"),
    subtasks: z.array(makeSubtaskProposalSchema(types)).min(1).max(maxSubtasks)
  });
}

/**
 * Reject an edge set that contains a cycle, by Kahn's algorithm over the
 * draft-local keys: repeatedly remove nodes with no unresolved prerequisites; if
 * any node survives, it is part of (or downstream of) a cycle.
 */
function assertAcyclic(proposal: DecompositionProposal): void {
  const remaining = new Map<string, Set<string>>(
    proposal.subtasks.map((s) => [s.localKey, new Set(s.dependsOn)])
  );
  let progressed = true;
  while (progressed && remaining.size > 0) {
    progressed = false;
    for (const [key, deps] of remaining) {
      // Ready when every prerequisite has already been removed.
      if ([...deps].every((d) => !remaining.has(d))) {
        remaining.delete(key);
        progressed = true;
      }
    }
  }
  if (remaining.size > 0) {
    throw new DecompositionValidationError(
      `dependency cycle among subtasks: ${[...remaining.keys()].join(", ")}`
    );
  }
}

/**
 * Snapshot the selected catalog entries onto a draft: validate every index against
 * the catalog, reject duplicates, and copy each entry's exact role+text. Indexes
 * are stored ascending so a Subtask's references read in conversation order
 * regardless of the order the model listed them.
 */
function resolveReferences(
  localKey: string,
  referenceIndexes: number[] | undefined,
  catalog: ReferenceCatalogEntry[]
): SubtaskReference[] {
  if (!referenceIndexes) return [];
  const seen = new Set<number>();
  for (const index of referenceIndexes) {
    if (seen.has(index)) {
      throw new DecompositionValidationError(
        `subtask ${localKey} references index ${index} more than once`
      );
    }
    seen.add(index);
    if (index > catalog.length) {
      throw new DecompositionValidationError(
        `subtask ${localKey} references unknown catalog index ${index} ` +
          `(catalog has ${catalog.length} ${catalog.length === 1 ? "entry" : "entries"})`
      );
    }
  }
  return [...referenceIndexes]
    .sort((a, b) => a - b)
    .map((index) => {
      // The catalog is 1-based; copy role+text verbatim (never the model's words).
      const entry = catalog[index - 1];
      return { role: entry.role, text: entry.text };
    });
}

/**
 * Resolve a validated model proposal into the drafts to persist.
 *
 * Throws {@link DecompositionValidationError} on any structural problem: blank
 * fields, duplicate local keys, unknown/duplicate reference indices, and unknown,
 * duplicate, self-referential, or cyclic dependency edges. On success, array order
 * is preserved — the data layer derives each Subtask's `ordinal` from it.
 */
export function resolveDecomposition(
  proposal: DecompositionProposal,
  catalog: ReferenceCatalogEntry[],
  types: SubtaskTypeRegistry
): { reply: string; drafts: SubtaskDraft[] } {
  const keys = new Set<string>();
  for (const s of proposal.subtasks) {
    if (keys.has(s.localKey)) {
      throw new DecompositionValidationError(
        `duplicate subtask local key: ${s.localKey}`
      );
    }
    keys.add(s.localKey);
  }

  // Every key must be registered before any edge is checked: an edge may point
  // forward to a subtask defined later in the array.
  for (const s of proposal.subtasks) {
    const seen = new Set<string>();
    for (const dep of s.dependsOn) {
      if (dep === s.localKey) {
        throw new DecompositionValidationError(
          `subtask ${s.localKey} depends on itself`
        );
      }
      if (!keys.has(dep)) {
        throw new DecompositionValidationError(
          `subtask ${s.localKey} depends on unknown key: ${dep}`
        );
      }
      if (seen.has(dep)) {
        throw new DecompositionValidationError(
          `subtask ${s.localKey} depends on ${dep} more than once`
        );
      }
      seen.add(dep);
    }
  }

  assertAcyclic(proposal);

  const drafts: SubtaskDraft[] = proposal.subtasks.map((s) => {
    const type = s.type.trim();
    let params;
    try {
      // Shape only. Whether an id names a row that exists — and is still usable —
      // is a question for durable state, answered when the execution starts.
      params = types.validateParams(type, s.params);
    } catch (err) {
      if (!(err instanceof SubtaskParamsError)) throw err;
      throw new DecompositionValidationError(
        `subtask ${s.localKey}: ${err.message}`
      );
    }
    return {
      localKey: s.localKey,
      type,
      prompt: s.prompt.trim(),
      references: resolveReferences(s.localKey, s.referenceIndexes, catalog),
      dependsOn: [...s.dependsOn],
      params
    };
  });

  return { reply: proposal.reply.trim(), drafts };
}
