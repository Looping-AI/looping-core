import type { RecipeExecutionRequest } from "../subtasks/types.js";
import type { ValidatedRecipe } from "../contract/recipe.js";

/**
 * Deterministic rendering of one subagent invocation. Pure — no model, no
 * Session, no lookups: everything comes verbatim from the request. The three
 * sections stay clearly separated and labeled so tests (and the model) can tell
 * them apart: the execution's budget, the main-agent instruction, and the
 * verbatim conversation reference snapshots.
 */

/**
 * A request whose Recipe has been through `validateRecipe`, so its limits are
 * merged rather than partial. Required rather than convenient: the budget line
 * below states a number to the model, and stating "up to undefined turns" — or
 * quietly rendering a Recipe's override as the whole budget — is worse than not
 * telling it at all.
 */
export type RenderableExecution = RecipeExecutionRequest & {
  recipe: ValidatedRecipe;
};

/**
 * The budget, in the terms the runner actually enforces.
 *
 * Worth its own section because a subagent that does not know its budget invents
 * one, and a *main* agent writing the prompt invents one for it: in one logged
 * play the instruction said "you have up to 20 actions total" — 20 was the turn
 * budget — and the subagent stopped after eleven game moves reasoning that it
 * must be out. Turns and actions are not the same currency and this is the line
 * that says so.
 */
function renderBudget(limits: ValidatedRecipe["limits"]): string {
  const minutes = Math.round(limits.maxWallMs / 60_000);
  return (
    `# Budget\nUp to ${limits.maxTurns} turns and about ${minutes} minutes. ` +
    "One turn is one tool call, however much that call does — anything a tool " +
    "counts internally is its own budget, not this one. Reaching either ceiling " +
    "does not drop your work: you get one last turn, with no tools, to write up " +
    "what you have."
  );
}
export interface RenderedInvocation {
  /** The validated Recipe soul, verbatim — the invocation's system prompt. */
  system: string;
  /** The sectioned user message (budget, instruction, references). */
  prompt: string;
}

/**
 * Render the sectioned user message for one execution. Reference snapshots are
 * emitted exactly as captured at decomposition — `[ref N]` labels with the
 * message role, no summarizing, rewriting, or interpolation. Sections with no
 * content are omitted entirely.
 */
export function renderSubagentPrompt(
  request: RenderableExecution
): RenderedInvocation {
  const sections: string[] = [renderBudget(request.recipe.limits)];

  const prompt = request.prompt.trim();
  if (prompt !== "") {
    sections.push(`# Task\n${prompt}`);
  }

  if (request.references.length > 0) {
    const refs = request.references.map(
      (ref, i) => `[ref ${i + 1}] (${ref.role}): ${ref.text}`
    );
    sections.push(
      "# Conversation references (verbatim snapshots of the caller's conversation)\n" +
        refs.join("\n")
    );
  }

  return { system: request.recipe.soul, prompt: sections.join("\n\n") };
}
