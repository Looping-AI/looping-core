#!/usr/bin/env node
/**
 * Publish gate: the checks that only fail at a consumer.
 *
 * Every defect this catches was a real one in this package, and none of them
 * failed `tsc`, `eslint`, or `vitest` — they only surfaced when something
 * outside the repo imported the built output. So they run on `prepack` and
 * `prepublishOnly`, where a failure is still cheap.
 *
 *   1. Every `exports` subpath resolves to a file that actually emitted.
 *   2. No relative import in `dist/` omits its `.js` extension (Node ESM throws
 *      `ERR_MODULE_NOT_FOUND` on those; `moduleResolution: "Bundler"` does not).
 *   3. No spec files reached `dist/`.
 *   4. Realm isolation: no *runtime* subpath can reach `node:*`, `undici`,
 *      `cloudflare:test` or `vitest` through any depth of relative import.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const failures = [];
const fail = (msg) => failures.push(msg);

/** Bare specifiers that must never be reachable from a runtime subpath. */
const TEST_ONLY = [/^node:/, /^undici$/, /^cloudflare:test$/, /^vitest$/];

const relativeImports = (source) =>
  [...source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]);

/** Every bare specifier reachable from `entry` through relative imports. */
function reachableBareSpecifiers(entry) {
  const seen = new Set();
  const bare = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of relativeImports(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        stack.push(path.resolve(path.dirname(file), spec));
      } else {
        bare.add(spec);
      }
    }
  }
  return bare;
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

// --- 1. every exports target exists -----------------------------------------

const subpathEntries = [];
for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
  const targets = typeof value === "string" ? [value] : Object.values(value);
  for (const target of targets) {
    if (!existsSync(path.join(root, target))) {
      fail(`exports "${subpath}" points at ${target}, which does not exist`);
    }
  }
  const runtime = typeof value === "string" ? value : value.import;
  if (runtime?.endsWith(".js")) subpathEntries.push([subpath, runtime]);
}

// --- 2 & 3. what reached dist/ ----------------------------------------------

for (const file of walk(path.join(root, "dist"))) {
  if (/\.spec\.(js|d\.ts)$/.test(file)) {
    fail(`spec file shipped to dist: ${path.relative(root, file)}`);
  }
  if (!file.endsWith(".js")) continue;
  for (const spec of relativeImports(readFileSync(file, "utf8"))) {
    if (spec.startsWith(".") && !spec.endsWith(".js")) {
      fail(
        `${path.relative(root, file)} imports "${spec}" without a .js extension ` +
          `— Node ESM will throw ERR_MODULE_NOT_FOUND`
      );
    }
  }
}

// --- 4. realm isolation ------------------------------------------------------

for (const [subpath, target] of subpathEntries) {
  // `/testing*` is the test harness and is expected to reach these; it is a
  // separate subpath precisely so it cannot enter a runtime graph.
  if (subpath.startsWith("./testing")) continue;
  const reachable = [...reachableBareSpecifiers(path.join(root, target))];
  const leaked = reachable.filter((s) => TEST_ONLY.some((r) => r.test(s)));
  if (leaked.length > 0) {
    fail(
      `runtime subpath "${subpath}" can reach test-only modules: ${leaked.join(", ")}`
    );
  }
}

// --- report ------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n✗ ${pkg.name} is not safe to publish:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error("");
  process.exit(1);
}

// stderr, not stdout: this runs from `prepack`, and `npm pack --json` expects
// stdout to be nothing but its own JSON.
console.error(
  `✓ ${pkg.name}: ${subpathEntries.length} runtime entries verified, ` +
    `${Object.keys(pkg.exports ?? {}).length} subpaths resolve, realms isolated`
);
