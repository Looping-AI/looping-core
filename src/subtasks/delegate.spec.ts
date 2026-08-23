import { describe, it, expect } from "vitest";
import { delegateCallOutput } from "./delegate.js";
import type { CompositionBranch } from "./types.js";

/**
 * What a delegating model is allowed to learn about a branch that did not
 * complete.
 *
 * This is the file that guards a reversal. `output` used to be `null` for
 * anything but `completed`, and the cost was measured: a parent that could see
 * `status: "failed"` and nothing else re-delegated one identical task twelve
 * times against a container whose TLS was broken, then apologised to the user
 * for a wall it had never been shown. The rule now is that a facet's `error` is
 * addressed to the model, so it reaches the model.
 */

const branch = (over: Partial<CompositionBranch> = {}): CompositionBranch => ({
  subtaskId: 1,
  round: 0,
  ordinal: 0,
  type: "claude-code",
  prompt: "edit the README",
  params: {},
  status: "completed",
  resultParts: [{ kind: "text", text: "done" }],
  error: null,
  ...over
});

describe("delegateCallOutput", () => {
  it("reports what a completed branch produced", () => {
    const [outcome] = delegateCallOutput([branch()]);
    expect(outcome?.status).toBe("completed");
    expect(outcome?.output).toBe("done");
  });

  it("tells the model why a failed branch failed", () => {
    const [outcome] = delegateCallOutput([
      branch({
        status: "failed",
        resultParts: null,
        error: "the dependency install failed: SELF_SIGNED_CERT_IN_CHAIN"
      })
    ]);
    expect(outcome?.status).toBe("failed");
    expect(outcome?.output).toContain("SELF_SIGNED_CERT_IN_CHAIN");
  });

  /**
   * A branch with nothing to say still says nothing. Cancellation is the usual
   * way to get here, and inventing a sentence for it would read to the model as
   * a diagnosis somebody made.
   */
  it("stays null for a branch that carries no reason", () => {
    const [outcome] = delegateCallOutput([
      branch({ status: "canceled", resultParts: null, error: null })
    ]);
    expect(outcome?.output).toBeNull();
  });

  /**
   * The bound applies to the failure path too, and that is the point of testing
   * it here: a *failing* branch is the likelier one to have dumped a build log
   * into `error`, and every earlier round's branches are replayed into every
   * later round's history.
   */
  it("bounds a runaway error rather than replaying it every round", () => {
    const [outcome] = delegateCallOutput([
      branch({ status: "failed", resultParts: null, error: "x".repeat(20_000) })
    ]);
    expect(outcome?.output?.length).toBeLessThan(9_000);
    expect(outcome?.output).toContain("truncated");
  });
});
