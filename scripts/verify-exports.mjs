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

/**
 * Drop comments, so prose is never mistaken for code.
 *
 * The scan below is a regex over text rather than an AST walk, and a doc comment
 * is free to *discuss* an import — this file's own checks are documented with the
 * specifiers they were written for. Without this, explaining a defect in a
 * comment is enough to re-report it, which is the fastest way to make a publish
 * gate something people learn to override.
 *
 * String-aware, because `"image/*"` is a real value in this package and a naive
 * strip would eat from there to the next `*​/`. Line comments are only recognised
 * at the start of a line, which is where every one in emitted output lives and
 * where a regex literal never is — that avoids having to lex regexes to tell
 * `/\/\//` from a comment.
 */
function stripComments(source) {
  let out = "";
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += source[++i] ?? "";
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "/" && /(^|\n)[ \t]*$/.test(out)) {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end - 1;
      continue;
    }
    out += c;
  }
  return out;
}

const relativeImports = (source) =>
  [...stripComments(source).matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map(
    (m) => m[1]
  );

/**
 * Every bare specifier reachable from `entry` through relative imports.
 *
 * A declaration graph is walked in declaration space. `tsc` emits `./x.js` in a
 * `.d.ts` as well, and `x.js` exists right beside `x.d.ts` in `dist/` — so
 * resolving naively would step out of the types graph on the first hop and
 * silently re-walk the runtime one, which is exactly the graph that has already
 * erased the type-only imports this pass exists to see.
 */
function reachableBareSpecifiers(entry) {
  const declarations = entry.endsWith(".d.ts");
  const resolve = (from, spec) => {
    const target = path.resolve(path.dirname(from), spec);
    if (!declarations || !target.endsWith(".js")) return target;
    const dts = `${target.slice(0, -".js".length)}.d.ts`;
    return existsSync(dts) ? dts : target;
  };

  const seen = new Set();
  const bare = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of relativeImports(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        stack.push(resolve(file, spec));
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
/** Every subpath's `types` target, for the checks that must see erased imports. */
const typeEntries = [];
for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
  const targets = typeof value === "string" ? [value] : Object.values(value);
  for (const target of targets) {
    if (!existsSync(path.join(root, target))) {
      fail(`exports "${subpath}" points at ${target}, which does not exist`);
    }
  }
  const runtime = typeof value === "string" ? value : value.import;
  if (runtime?.endsWith(".js")) subpathEntries.push([subpath, runtime]);
  const types = typeof value === "string" ? undefined : value.types;
  if (types?.endsWith(".d.ts")) typeEntries.push([subpath, types]);
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
 * Both graphs are walked, and the `.d.ts` one is not optional. A **type-only**
 * import is erased from the emitted `.js` and survives only in the declarations,
 * so scanning the runtime graph alone would report "every import declared" while
 * an undeclared package still breaks a pnpm or Yarn PnP consumer's `tsc`. That
 * was how the type-only half of the `@ai-sdk/provider` usage surfaced once the
 * value import had moved to `ai`. Both halves are gone now — the package is not
 * a dependency here at all — but the declaration walk is why the second one
 * could not hide.
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
 * A second line of defence behind {@link stripComments}: the scan is a regex
 * over text, not an AST walk, so anything that survives and does not even have
 * the shape of a package name is prose rather than a dependency. Reporting one
 * as undeclared is how a publish gate earns a reputation for crying wolf.
 */
const PACKAGE_SPECIFIER =
  /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*/i;

/** `@scope/name/deep/path` → `@scope/name`; `name/sub` → `name`. */
const packageName = (specifier) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

for (const [kind, entries] of [
  ["imports", subpathEntries],
  ["declares a type from", typeEntries]
]) {
  for (const [subpath, target] of entries) {
    for (const spec of reachableBareSpecifiers(path.join(root, target))) {
      if (spec.startsWith("node:") || spec.startsWith("cloudflare:")) continue;
      if (!PACKAGE_SPECIFIER.test(spec) || /\s/.test(spec)) continue;
      const name = packageName(spec);
      if (!declared.has(name)) {
        fail(
          `subpath "${subpath}" ${kind} "${spec}", but ${name} is in neither ` +
            `dependencies nor peerDependencies — it resolves here only because ` +
            `npm hoisted it, and will not resolve under pnpm or Yarn PnP`
        );
      }
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
