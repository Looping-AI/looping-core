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
 *   4. No source maps reached `dist/`. Their `sources` is `../src/*.ts`, which
 *      is not published, so every one is dangling — and a consumer's test runner
 *      prints "Sourcemap for … points to missing source files" once per module
 *      it loads, every run. `build` cleans `dist/` first, so this also catches
 *      the stale-artifact case that made the original defect survive a rebuild.
 *   5. Realm isolation: no *runtime* subpath can reach `node:*`, `undici`,
 *      `cloudflare:test` or `vitest` through any depth of relative import.
 *   6. Every bare specifier a subpath reaches is a declared dependency. Hoisting
 *      makes an undeclared one work in this repo and nowhere stricter.
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

// --- 2, 3 & 4. what reached dist/ -------------------------------------------

for (const file of walk(path.join(root, "dist"))) {
  if (/\.spec\.(js|d\.ts)$/.test(file)) {
    fail(`spec file shipped to dist: ${path.relative(root, file)}`);
  }
  if (file.endsWith(".map")) {
    fail(
      `source map shipped to dist: ${path.relative(root, file)} — its sources ` +
        `are under src/, which this package does not publish, so it dangles at ` +
        `every consumer`
    );
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

// --- 5. realm isolation ------------------------------------------------------

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

// --- 6. every bare specifier is declared -------------------------------------

/**
 * A package a consumer must install is one this package must declare. Anything
 * else works here and only here, because npm hoists a transitive dependency into
 * a flat `node_modules` that a consumer's package manager may not reproduce —
 * pnpm and Yarn PnP do not, and neither does npm once the intermediate package
 * restructures.
 *
 * The defect that motivated this: `@ai-sdk/provider` was imported for its
 * `APICallError` from `/testing`, which every consumer loads, while appearing in
 * no dependency field at all. It resolved through `ai`'s own copy, so nothing in
 * this repo noticed — the exact shape of failure this file exists to catch.
 *
 * `node:*` and `cloudflare:*` are excluded because check 5 already governs who
 * may reach them, and subpath imports (`ai/test`, `agents/experimental/...`) are
 * reduced to their package name before the lookup. The package's own name is
 * allowed: a self-reference resolves through `exports`, which check 1 has
 * already verified.
 */
const declared = new Set([
  pkg.name,
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {})
]);

/**
 * A specifier that could actually be a package.
 *
 * `relativeImports` scans text, not an AST, so it also matches the word
 * `import` followed by a quoted string inside a doc comment. Those are prose —
 * they contain spaces and newlines, which no package name may — and reporting
 * one as an undeclared dependency would make this check untrustworthy on its
 * first false alarm. Cheaper and more honest than teaching the scanner to strip
 * comments, which risks mangling any string containing `//`.
 */
const PACKAGE_SPECIFIER =
  /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*/i;

/** `@scope/name/deep/path` → `@scope/name`; `name/sub` → `name`. */
const packageName = (specifier) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

for (const [subpath, target] of subpathEntries) {
  for (const spec of reachableBareSpecifiers(path.join(root, target))) {
    if (spec.startsWith("node:") || spec.startsWith("cloudflare:")) continue;
    if (!PACKAGE_SPECIFIER.test(spec) || /\s/.test(spec)) continue;
    const name = packageName(spec);
    if (!declared.has(name)) {
      fail(
        `subpath "${subpath}" imports "${spec}", but ${name} is in neither ` +
          `dependencies nor peerDependencies — it resolves here only because ` +
          `npm hoisted it, and will not resolve under pnpm or Yarn PnP`
      );
    }
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
    `${Object.keys(pkg.exports ?? {}).length} subpaths resolve, realms isolated, ` +
    `every import declared`
);
