import { describe, it, expect } from "vitest";
import type { RunnerTestCase, RunnerTestSuite } from "vitest";
import { cassetteNameFor } from "./vcr-spec.js";

/**
 * A cassette name is a **filename committed to a repo**, so the only property
 * that matters is that it depends on nothing outside the repo. It is derived
 * from a Vitest task, and the derivation used to take `.pop()` of a split that
 * could fail to match — which returns the input unchanged, i.e. the absolute
 * path, i.e. a name containing the developer's home directory. That reproduces
 * as "works on my machine, missing cassette in CI", so it is pinned here.
 */

/** Minimal task tree: a File task at the root, then nested describe suites. */
function task(filepath: string, name: string, suites: string[] = []) {
  // Only the three fields the derivation reads are populated; casting through
  // `unknown` because a real task carries a dozen more that nothing here needs.
  let suite = { filepath } as unknown as RunnerTestSuite;
  for (const suiteName of suites) {
    suite = { name: suiteName, suite } as unknown as RunnerTestSuite;
  }
  return { name, suite, file: { filepath } } as unknown as RunnerTestCase;
}

describe("cassetteNameFor", () => {
  it("names a spec under test/ by its path below test/", () => {
    expect(
      cassetteNameFor(
        task("/home/dev/repo/test/arc-agi/recorded.spec.ts", "plays a game")
      )
    ).toBe("arc-agi-recorded--plays-a-game.snapshot.json");
  });

  it("names a spec beside its code under src/ the same way", () => {
    // Core's own convention, and a consumer's may match it. Before this, such a
    // spec had no `/test/` to split on and got the whole absolute path.
    expect(
      cassetteNameFor(
        task("/home/dev/repo/src/arc-agi/recorded.spec.ts", "plays a game")
      )
    ).toBe("arc-agi-recorded--plays-a-game.snapshot.json");
  });

  it("falls back to the bare filename under neither root", () => {
    expect(
      cassetteNameFor(task("/home/dev/repo/recorded.spec.ts", "a b"))
    ).toBe("recorded--a-b.snapshot.json");
  });

  it("ignores a test/ or src/ segment in the path above the repo", () => {
    // The actual defect. `~/src/work/…` is an ordinary layout, and cutting at
    // the *first* match would put the developer's directory names into a
    // committed filename — different per machine, so CI could never find it.
    expect(
      cassetteNameFor(
        task("/home/dev/src/work/repo/test/recorded.spec.ts", "one")
      )
    ).toBe("recorded--one.snapshot.json");
  });

  it("includes each describe level, in order, kebab-cased", () => {
    expect(
      cassetteNameFor(
        task("/repo/test/arc-agi/recorded.spec.ts", "Reads The Score!", [
          "arc (recorded real API)",
          "scoring"
        ])
      )
    ).toBe(
      "arc-agi-recorded--arc-recorded-real-api--scoring--reads-the-score.snapshot.json"
    );
  });

  it("handles Windows separators", () => {
    expect(
      cassetteNameFor(task("C:\\repo\\test\\arc-agi\\recorded.spec.ts", "one"))
    ).toBe("arc-agi-recorded--one.snapshot.json");
  });
});
