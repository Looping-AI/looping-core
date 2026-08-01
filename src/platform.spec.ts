import { describe, it, expect } from "vitest";
import {
  CHUNK_SOFT_MS,
  MAX_CHUNKS_PER_BRANCH,
  STEP_TIMEOUT_MS,
  STEPS_PER_INSTANCE
} from "./platform.js";
import { DEFAULT_CORE_CONFIG } from "./config.js";

/**
 * The arithmetic `platform.ts` claims but cannot enforce.
 *
 * Each constant there is documented as "held unreachable by" a relationship to
 * another one. Those relationships are load-bearing — the bug the file was
 * extracted during was exactly a derived bound drifting from the platform fact
 * it was sized against — and nothing but a test keeps them true when someone
 * nudges a default in `config.ts`.
 */
describe("platform bounds", () => {
  it("checkpoints a chunk well inside the Workflows step timeout", () => {
    expect(CHUNK_SOFT_MS).toBeLessThan(STEP_TIMEOUT_MS);
    // Not merely under it: a model turn already in flight when the soft limit
    // trips still has to finish inside the same step.
    expect(STEP_TIMEOUT_MS - CHUNK_SOFT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("cannot exhaust the chunk ceiling before the turn budget", () => {
    // A yielding chunk always advanced at least one turn, so a run takes at most
    // `maxTurns` chunks. Keeping the ceiling above that is what makes reaching
    // it a bug rather than a budget.
    expect(MAX_CHUNKS_PER_BRANCH).toBeGreaterThan(
      DEFAULT_CORE_CONFIG.subagentLimits.maxTurns
    );
  });

  it("keeps the worst-case step product under one Workflow instance", () => {
    // Every subtask fanned out, each burning the full chunk ceiling.
    const worstCase = DEFAULT_CORE_CONFIG.maxSubtasks * MAX_CHUNKS_PER_BRANCH;
    expect(worstCase).toBeLessThan(STEPS_PER_INSTANCE);
  });
});
