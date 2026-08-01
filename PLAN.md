# looping-core — plan

> Sibling repos: [`looping-plugins`](https://github.com/Looping-AI/looping-plugins) ·
> [`looping-starter`](https://github.com/Looping-AI/looping-starter)

## What this repo is

`@looping/core` — everything an agent cannot choose not to have: the zero-trust A2A
contract, the durable task lifecycle, the delegation and subagent runtime, and the test
harness.

**Rule of admission.** A file belongs here only if *every* agent needs it, or if it
defines a type a plugin must implement. Anything optional is a plugin. Anything
opinionated is the starter's.

---

## Where the code comes from

Two predecessor repos, `proactive-agent` and `proactive-agent`'s hard fork
`reactive-agent` (fork commit `9f380c7`), each ran ~27 commits independently. **Both are
now legacy/deprecated** — nothing migrates onto core, no live DO data is at stake. Core is
built greenfield and *mines* both for the better implementation of each concern.

What the fork left behind is the charter for this package:

- `a2a/verify.ts`, `agent/recall.ts`, `test/helpers/auth.ts`, the eslint rule,
  `scripts/generate-keys.mjs`, `drizzle.config.ts`, migration `m0000` — **byte-identical**
  in both repos.
- `wrangler.jsonc` differs by renames plus one secret, **including every comment verbatim**.
- `AGENTS.md` constraints 2–5 (EdDSA, never weaken `verify.ts`, zero shared secrets,
  `GATEWAY_ORIGINS`) are **word-for-word identical**.

Divergence is bidirectional: **proactive is ahead on A2A v1.0 protocol work**, **reactive
is ahead on the entire delegation stack** (~7,900 src lines proactive never received).
Core takes the newer side per area.

---

## Layout

```
src/
  a2a/          card, verify, notify, task, task-store, executor, parts, context
  worker/       createA2AWorker()  — JWKS → signed card → verify → JSON-RPC
  runtime/      createAgentRuntime()  — the plugin registry
  agent/        session, history, model, inference, budget, control, final-reply
  subtasks/     types, subtask-types, decomposition, delegate, scheduler, catalog
  subagent/     RecipeSubagent, run, prompt, fingerprint
  db/           schema (notify_tasks, subtasks), models, migrations, AgentDB
  platform.ts   Cloudflare Workflows step/instance facts
  contract.ts   AgentPlugin, PluginStore, ToolFamilyContext, PLUGIN_CONTRACT_VERSION
testing/        VCR harness, mock-model, FakeSession, freshStub/doStorage, JWK fixtures
eslint/         no-deprecated-object-properties
```

## Exports — subpaths, no root barrel

Same discipline `looping-plugins` uses, for the same reason, plus `/testing` and `/eslint`
must never enter the runtime graph.

| Subpath | Contents | ~LOC |
|---|---|---|
| `@looping/core` | `contract.ts`, `createAgentRuntime`, shared types | 300 |
| `@looping/core/a2a` | card signing, JWKS, gateway-JWT verify, push notify, task store, executor | 1,000 |
| `@looping/core/worker` | `createA2AWorker({ manifest, agent, workflow, … })` | 250 |
| `@looping/core/agent` | session, history, model, inference, budget, control, final-reply | 870 |
| `@looping/core/subtasks` | delegation types, decomposition, delegate tool, wave scheduler | 1,000 |
| `@looping/core/subagent` | `RecipeSubagent`, `runResumableChunk`, fingerprint, prompt | 1,150 |
| `@looping/core/db` | `AgentDB`, `notify_tasks` + `subtasks` schema/models, migrations | 750 |
| `@looping/core/testing` | VCR (361), mock-model, `FakeSession`, DO helpers, JWK fixtures | 680 |
| `@looping/core/eslint` | the custom rule | 81 |

≈ **6,000 lines.** Roughly reactive's agent/subagent/db plus proactive's a2a/worker.

---

## Provenance — what to lift, and from where

Paths are relative to `../reactive-agent` (R) and `../proactive-agent` (P).

| Target | Take from | Why |
|---|---|---|
| `a2a/verify.ts` | either (identical) | Make `IDENTITY_CLAIM` config, not a hardcoded `https://looping.ai/identity`. Generalize `GatewayIdentity` |
| `a2a/card.ts` | **P structure + R's `securitySchemes`** | P is newer and argues the fixed-point property; R's decision to advertise `gatewayJwt` wins. `buildBaseCard(manifest, origin)` — manifest injected, not imported (kills `R:a2a/card.ts:7`) |
| `a2a/{notify,task,task-store,executor,parts,context}.ts` | **P** | P is on A2A v1.0: `V1PushNotificationSerializer`, `ListTasks` offset paging + filters, `SendMessageRequest.fromJSON`, `ServerCallContext` bridge. P's `parts.ts` supersedes R's thinner `a2a/inbound.ts` |
| `worker/` | **P** `src/index.ts` → `createA2AWorker({...})` | P adds `validateVersion` enforcement, `jsonRpcErrorResponse`, extension response headers |
| `db/models/tasks.ts`, `notify_tasks` | **R** + P's `list`/`count`/`context_id` | See "task_json" below |
| `agent/{session,history,model,inference,budget,control,final-reply}.ts` | **R** | R has deterministic Session message ids, `appendOnce`, `ControlTool`, `TurnBudget`, `GatewayMetadata`, reasoning-effort. `inference.ts` is literally extracted from P's `loop.ts` — take R's factored version |
| `subtasks/*`, `subtasks` table | **R** | No P analog |
| `subagent/*` | **R** | No P analog. `run.ts` already takes 100% injected deps — the cleanest big lift in either repo |
| `platform.ts` | **R** | Ships unchanged |
| `testing/` | **R** (VCR, `FakeSession`) + **P** (`MockLanguageModelV4`) | VCR is 361 LOC with zero project coupling |
| `eslint/` | either (identical) | |

### Two settled conflicts

**`card.ts` `securitySchemes` — advertised.** P *deliberately omits* it (documented: the
served card must be a fixed point under repeated `fromJSON`); R *deliberately advertises*
`gatewayJwt`. R wins on the behavior. **Keep P's fixed-point property as a pinned test** —
that's the part worth preserving from P's argument.

**`notify_tasks.task_json` — `Task.toJSON` / `Task.fromJSON` (R's).** Note the premise
correction: this column is the DO's own SQLite and **the gateway never sees it**. What the
gateway receives is built separately in `R:src/a2a/notify.ts:234` via
`StreamResponse.toJSON(...)`, and both repos already agree on that wire form. So the choice
is purely internal — take R's because what's on disk is then exactly what goes on the wire,
and both survive SDK class-shape changes. P's raw `JSON.stringify(task)` persists in-memory
class internals.

---

## Dependencies and bindings

- **deps:** `@a2a-js/sdk`, `jose`, `drizzle-orm`, `zod`
- **peers:** `agents` (Agents SDK), `ai`, `workers-ai-provider` — never bundled. Two copies
  of `agents` in one Worker breaks the `Session`/`SessionMessage` types and `instanceof`.
- **bindings a consumer must provide:** `AI`, one Durable Object, one Workflow, secrets
  `A2A_SIGNING_KEY` + `GATEWAY_ORIGINS`. Nothing else is mandatory.

---

## What core deliberately does NOT contain

- `turn.ts` / `loop.ts` / `triage.ts` **bodies**. Core ships `RunTurnArgs`, `ControlTool`,
  `TurnBudget`; the app writes the loop.
- The DO class bodies and Workflow bodies.
- `agent/prompt.ts` `SOUL` — 7 lines of app copy today. The main agent is the one "recipe"
  with no Recipe; the starter supplies its soul exactly as a plugin supplies a subagent's.
- `config.ts` **values** (model ids, budgets, limits). Core ships the shapes.
- Vectorize recall, browser tools, `@cloudflare/shell` — all optional → plugins.
- `WorkspaceHandle` is a **split**: the *interface* is core (`ToolFamilyContext` references
  it), the `@cloudflare/shell`-backed *implementation* is `@looping/plugins/workspace`.

---

## The two constraints core is guardian of

1. **`verify.ts` is never weakened**: `jku` present → origin allowlist → `iss === jku` →
   `jwtVerify`. Word-for-word identical in both predecessor repos; it is the zero-trust
   contract and the reason this package exists.
2. **The served AgentCard is a fixed point under repeated `fromJSON`.** Signing goes
   through the SDK, over the wire card, `toJSON` before sign.

Both get pinned tests before anything else lands.

---

## The load-bearing refactor: kill module-load-time composition

Everything else in this repo is file moves. This is the actual work, and it is
**done in `../reactive-agent` first**, where the 13.3k-line test suite already runs.

Today the recipe registry resolves at *import time*:

- `recipes/index.ts` exports a frozen `SUBTASK_TYPE_SPECS` array
- → `subtask-types.ts` builds `SUBTASK_TYPES` / `SUBTASK_TYPE_KEYS` as module consts
- → `decomposition.ts` does `z.enum(SUBTASK_TYPE_KEYS)` at module scope
- → `turn.ts:207` composes `TURN_INSTRUCTIONS` at module load from the manifest
- → `delegate.ts` renders its tool description at module load
- → `validation.ts:37` hardcodes `KNOWN_TOOL_FAMILIES = Set(["browser","workspace","arc-game"])`
- → `config.ts` is statically imported by ~12 modules

Module-load-time registry reads defeat tree-shaking *and* runtime plugin selection — and
they're wrong on Workers anyway, where `env` doesn't exist at module scope. One fix:

```ts
// built once per DO instance, in onStart()
const runtime = createAgentRuntime({ config, plugins: plugins(this.env) });
```

Everything currently frozen at import becomes a field on `runtime`. The five leaks that
die with it (all paths in `../reactive-agent`):

1. `src/agent/subtasks/types.ts:2` — `import type { FrameResponse } from "@/recipes/arc-game/types"`;
   `SubtaskRuntime` carries 4 ARC fields (`cardId`, `cookies`, `guid`, `frame`).
   → `SubtaskRuntime` becomes a generic/opaque bag.
2. `src/agent/tools.ts:11,15,198-217` — the `if (family === ARC_GAME_FAMILY)` chain.
   → family registry map built from `plugins`.
3. `src/reactive-agent/index.ts:22,30,31` — `makeArcClient` / `resolveScorecard` /
   `ARC_GAME_FAMILY`, plus the methods `resolveRuntime`, `arcScorecardDeps`,
   `leaseScorecard`/`leasePlay`, `enrichResult`. → plugin lifecycle hooks.
   **Keep `leaseScorecard`'s in-flight-promise dedupe in core** as generic "collapse
   concurrent resolutions" machinery — that part isn't ARC-specific.
4. `src/db/models/scorecards.ts:5` — the DB layer importing a domain type.
   → plugin-owned store, see `looping-plugins/PLAN.md`.
5. `src/a2a/card.ts:7` — `import { manifest } from "@/reactive-agent/manifest"`. → parameter.

---

## Known hazards

**`subagent/fingerprint.ts` is a versioning landmine.** It canonicalizes
`resolveLimits(recipe.limits)`, merged against `SUBAGENT_LIMITS`. Once that baseline lives
in a versioned package, a patch bump that nudges a default **strands every in-flight
subagent run** (fingerprint mismatch → cache miss → re-execute). Fix during the lift: hash
a declared `fingerprintVersion`, not the resolved limits.

**`ToolFamilyContext.env: Env` cannot survive publication.** `Env` is the ambient global
`wrangler types` generates into `worker-configuration.d.ts`. The contract must be generic
or config-at-instantiation. Audit for stray `ctx.env` reads during the lift.

**`agents` is a viral peer.** Five distinct entrypoints in use; `SessionMessage` is a viral
type across 5 core files. Peer, never bundled.

**AI SDK version skew.** P is on `ai@^7.0.40` / `MockLanguageModelV4`, R on `^7.0.37` /
`MockLanguageModelV3`. Standardize on V4, ship one mock.

**`@cloudflare/codemode` is declared in both predecessor `package.json`s and imported
nowhere** — zero occurrences in `src/`, `test/`, or docs. Drop it, or claim the slot
deliberately.

---

## Cross-repo mechanics this repo owns

Three separate repos cost atomic contract changes — a contract change is a three-repo
publish train (core → publish → plugins → publish → starter). Core owns the two mechanics
that make that survivable:

1. **`PLUGIN_CONTRACT_VERSION`** exported from `contract.ts`, asserted when the starter
   registers plugins. Version skew fails at startup with a readable message, not a
   confusing structural-type error.
2. **Additive-only contract after v1.** New plugin capabilities arrive as optional fields
   on `AgentPlugin`; breaking changes need a core major, and the assert makes the break loud.

Local dev: consumers use `file:../looping-core` overrides for the fast inner loop and
`npm pack` + tarball install for pre-release verification. **Not `npm link`** — it
duplicates peer deps, and two copies of `agents` in one Worker bundle breaks the Session
types. CI always installs from the registry so a link-only-works build can never ship.

---

## Milestones

1. **Refactor in place in `../reactive-agent`** — `createAgentRuntime`, family map, plugin
   hooks on the DO, generic `SubtaskRuntime`. Arc-game becomes a local plugin under the new
   contract, still in-repo. Suite stays green. *This is the risky step and it does not
   happen in this repo.*
2. **Fold in proactive's A2A v1.0 layer** (`parts.ts`, `context.ts`,
   `V1PushNotificationSerializer`, `ListTasks` paging, `validateVersion`,
   `SendMessageRequest.fromJSON`) while still in one tree, so core is born on the newer
   protocol rather than retrofitting it.
3. **Cut this repo** — mostly file moves once 1–2 land. Scaffold, move code + its specs,
   wire subpath exports, pin the two guardian constraints.
4. **Publish `0.1.0` to the `next` dist-tag.** Promote to `latest` only after
   `looping-starter`'s three examples are green against it.

## Verification

- Every spec suite moves with its code and stays green (`vitest run`).
- Guardian tests: `verify.ts` rejection matrix; AgentCard fixed-point under repeated
  `fromJSON` **with** `securitySchemes` present.
- `@looping/core/testing` and `/eslint` are absent from a consumer's runtime bundle.
- Real proof lives in `looping-starter`: three examples, bundle-isolation check, and a
  full task round-trip against the live gateway.
