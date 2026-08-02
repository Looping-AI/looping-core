# AGENTS.md — working in `@loopingai/core`

This package is the mandatory floor under every Looping agent. It is consumed by
[`looping-plugins`](https://github.com/Looping-AI/looping-plugins) (optional,
composable capabilities) and
[`looping-starter`](https://github.com/Looping-AI/looping-starter) (the app that
composes them).

Because this is a **published npm package**, most mistakes are invisible in this
repo and only fail at a consumer's build. The constraints below exist for that
reason.

---

## The zero-trust constraints — non-negotiable

These arrived byte-identical from two independently-evolved predecessor agents.
They are the reason this package exists.

1. **Never weaken `src/a2a/verify.ts`.** The four checks — `jku` present → origin
   allowlist → `iss` origin equals `jku` origin → `jwtVerify` pinned to EdDSA —
   are the whole contract. Do not make any of them optional, do not reorder the
   allowlist check after the JWKS fetch, and **do not add a local-development
   bypass**; run a local gateway instead. `verify.spec.ts` asserts each one
   negatively, including that an unlisted `jku` is rejected before any fetch.

2. **EdDSA (Ed25519) only.** Both the gateway JWT and the AgentCard signature.
   Any other algorithm is rejected.

3. **Zero shared secrets, in either direction.** The agent verifies the gateway
   against the gateway's public JWKS; the gateway verifies the agent against the
   agent's, pinned on first registration (Trust-On-First-Use). Nothing symmetric
   ever crosses the boundary. The only two secrets an agent carries are
   `A2A_SIGNING_KEY` (its own private JWK) and `GATEWAY_ORIGINS`.

4. **`GATEWAY_ORIGINS` is the allowlist boundary.** Normalized to exact origins,
   never matched by suffix or pattern. An empty or unparseable value fails loudly
   rather than degrading to an allowlist that rejects everything identically.

5. **The served AgentCard is a fixed point under repeated `fromJSON`.** A
   verifier re-encodes what it fetched before checking the signature, so a
   document that decodes differently the second time fails in production while
   every local round-trip looks fine. `card.spec.ts` pins this.

Generate a keypair with `npm run keys`.

---

## Publishing constraints

The package has no root barrel; every area is its own subpath export. Three rules
follow from that, and all three have already been violated once:

- **Always write `.js` on relative imports.** `moduleResolution: "Bundler"`
  typechecks extensionless specifiers, but `tsc` emits them verbatim and Node ESM
  then throws `ERR_MODULE_NOT_FOUND` at the consumer.

- **Never mix realms in one module graph.** `@loopingai/core/testing` is the
  workerd half (may reach `cloudflare:test`); `@loopingai/core/testing/node` and
  `/testing/vcr-global-setup` are the Node half (may reach `undici`, `node:fs`).
  `src/testing/vcr-shared.ts` is the only module both may load, and it must stay
  dependency-free. **No runtime subpath may reach any of them.**

- **Never name a consumer's ambient `Env`.** Core declares its own env slices in
  `src/env.ts` and takes bindings as parameters. The one exception is the
  namespaced `Cloudflare.Env`, which is a declaration-merging seam the Agents SDK
  itself constrains its base class to — see the note in `tsconfig.json`.

Adding an export subpath means adding it to `package.json`'s `exports` **and**
confirming it emits: a subpath that resolves to a missing file is invisible until
someone imports it.

---

## Contract changes

`PLUGIN_CONTRACT_VERSION` in `src/contract/plugin.ts` is asserted at DO start, so
a plugin built against a different core fails with a readable message instead of
a structural-type error several frames away.

The contract is **additive-only within a major**: new capabilities arrive as
optional fields on `AgentPlugin`. Removing or re-typing an existing field needs a
core major and a version bump. Remember that a contract change is a three-repo
publish train (core → plugins → starter), so one repo is always briefly behind.

> **v1 was amended in 0.1.2, before its first consumer.** `shouldHandleTurn` and
> `workspaceBacking` were added and `mainAgentTools` was re-typed from
> `() => ToolSet` to `(ctx) => ToolSet | Promise<ToolSet>`. The re-type would
> normally require the bump above; it was skipped deliberately, because that rule
> exists to stop a _published_ plugin failing with a structural-type error several
> frames from its cause, and at 0.1.2 no plugin had been published against v1.
> This is the one such amendment. Treat v1 as frozen from here.

`FINGERPRINT_VERSION` in `src/subagent/fingerprint.ts` works the same way and is
even sharper: bumping it invalidates every cached subagent result and every
in-flight run's checkpoint. Note that recipe limits are hashed **as declared, not
as merged** — that is deliberate, so moving a baseline default in a patch release
cannot strand in-flight runs.

---

## Working here

```bash
npm run check     # prettier + eslint + tsc (src) + tsc (test) + build
npm test          # vitest, inside real workerd
npm run keys      # generate an Ed25519 A2A_SIGNING_KEY
npm run types     # regenerate worker-configuration.d.ts from wrangler.jsonc
```

Specs live next to the code they test (`src/**/*.spec.ts`) and run inside
workerd, because `AgentDB` drives `ctx.storage.sql` and the Agents SDK `Session`
has no Node-side stand-in. `wrangler.jsonc` and `test/worker.ts` exist only to
give the pool something to bind — they are dev-only and excluded from the
published tarball.

Two things `npm test` alone will not catch, so run `npm run check` before
pushing: vitest transpiles specs without typechecking them, and formatting and
the type-aware `no-deprecated` rule only run under `check`.
