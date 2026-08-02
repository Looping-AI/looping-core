import { beforeEach, afterEach } from "vitest";
import type { RunnerTestCase, RunnerTestSuite } from "vitest";
import { VCR_CONTROL_ORIGIN } from "./vcr-shared.js";

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
 * The spec's path relative to the project root.
 *
 * Vitest already computes this as `file.name`, which is the whole answer: it is
 * stable across machines and checkouts, and it is *unique per spec file*, which
 * is what a cassette name has to be.
 *
 * Deriving it from `filepath` instead — by stripping a leading `test/` or
 * `src/` — got this wrong twice. Splitting on a segment that never matched
 * returned the absolute path unchanged, so a cassette was named after the
 * developer's home directory; and stripping *both* roots collapsed
 * `test/api.spec.ts` and `src/api.spec.ts` onto one name, which for a store
 * keyed solely by filename means one recording silently overwrites the other
 * and playback serves the wrong responses.
 *
 * The fallback is only for a runner that does not populate `name`; a bare
 * filename can still collide, but it is strictly better than an absolute path
 * and nothing here reaches it.
 */
function relativeSpecPath(file: RunnerTestCase["file"]): string {
  if (typeof file.name === "string" && file.name !== "") return file.name;
  return file.filepath.replace(/\\/g, "/").split("/").pop()!;
}

/**
 * Cassette filename for a test: `kebab(<project-relative path, minus
 * .spec.ts>)` then each describe level then the test name, all kebab-cased and
 * joined by `--`, plus `.snapshot.json`. Example:
 * `test-arc-agi-recorded--arc-recorded-real-api--plays-a-real-game.snapshot.json`.
 * Exported for debugging / the cassette-rename step.
 */
export function cassetteNameFor(task: RunnerTestCase): string {
  const rel = relativeSpecPath(task.file).replace(/\.spec\.ts$/, "");

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
        `No VCR cassette "${cassette}". Record it with \`RECORD=1\` ` +
          `(add \`-t "${ctx.task.name}"\` to record only this test), which needs ` +
          `whatever real credentials the recorded API calls require.`
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
