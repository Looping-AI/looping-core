import { beforeEach, afterEach } from "vitest";
import type { RunnerTestCase, RunnerTestSuite } from "vitest";
import { VCR_CONTROL_ORIGIN } from "./vcr-shared";

/**
 * Worker-side half of the VCR harness. `setupRecording()` is the *only* thing a
 * recorded spec wires up: one call at the top of the file gives every `it` its
 * own cassette, auto-named from the file + describe + test names, recorded under
 * `RECORD=1` and replayed otherwise. No per-recipe config, no registry.
 *
 * How it reaches the Node-side agent: specs run in workerd (no filesystem), so
 * the active cassette is announced over an in-band control channel — a `fetch`
 * to {@link VCR_CONTROL_ORIGIN} that `VcrAgent` (test/helpers/vcr.ts) answers
 * from the same Miniflare `fetchMock` every worker fetch already flows through.
 */

const kebab = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The File task (root of the tree) carries `filepath`; describe suites don't. */
function isFileTask(suite: RunnerTestSuite): boolean {
  return typeof (suite as { filepath?: string }).filepath === "string";
}

/**
 * Cassette filename for a test: `kebab(<file rel to test/, minus .spec.ts>)`
 * then each describe level then the test name, all kebab-cased and joined by
 * `--`, plus `.snapshot.json`. Example:
 * `recipes-arc-game-recorded--arc-game-recorded-real-api--starts-a-real-game-and-closes-the-scorecard-on-abort.snapshot.json`.
 * Exported for debugging / the cassette-rename step.
 */
export function cassetteNameFor(task: RunnerTestCase): string {
  const rel = task.file.filepath
    .split(/[\\/]test[\\/]/)
    .pop()!
    .replace(/\.spec\.ts$/, "");

  const suites: string[] = [];
  let suite: RunnerTestSuite | undefined = task.suite;
  while (suite && !isFileTask(suite)) {
    suites.unshift(suite.name);
    suite = suite.suite;
  }

  return [rel, ...suites, task.name].map(kebab).join("--") + ".snapshot.json";
}

/**
 * Call once at the top of a recorded spec file (outside any `describe`). Adds
 * per-test hooks that activate the test's cassette before it runs and release
 * it after. A missing cassette **fails** the test with instructions to record
 * (never skips — CI must go red so the gap is visible).
 */
export function setupRecording(): void {
  beforeEach(async (ctx) => {
    const cassette = cassetteNameFor(ctx.task);
    const res = await fetch(`${VCR_CONTROL_ORIGIN}/use?cassette=${cassette}`, {
      method: "POST"
    });
    if (res.status === 404) {
      throw new Error(
        `No VCR cassette "${cassette}". Record it with \`npm run test:record\` ` +
          `(add \`-- -t "${ctx.task.name}"\` to record only this test), which ` +
          `needs a real ARC_API_KEY in .env.test.`
      );
    }
    if (res.status === 409) {
      throw new Error(
        `VCR cassette "${cassette}" could not activate: another recorded test is ` +
          `already using the shared agent. Recorded specs must not run in ` +
          `parallel — keep them sequential.`
      );
    }
    if (!res.ok) {
      throw new Error(
        `VCR control channel error (HTTP ${res.status}) activating "${cassette}".`
      );
    }
  });

  afterEach(async () => {
    await fetch(`${VCR_CONTROL_ORIGIN}/release`, { method: "POST" });
  });
}
