# @loopingai/core

**The mandatory foundation for a Looping agent on Cloudflare Workers.**

Zero-trust A2A (signed AgentCard, gateway-JWT verification, no shared secrets), the
durable task lifecycle, the delegation and subagent runtime, and the test harness.

You bring the loop and the prompts. Core brings everything you cannot choose not to have.

```bash
npm install @loopingai/core
```

> Part of a three-package split:
> **`@loopingai/core`** (this) ·
> [`looping-plugins`](https://github.com/Looping-AI/looping-plugins) (optional, composable capabilities) ·
> [`looping-starter`](https://github.com/Looping-AI/looping-starter) (a working agent that composes them).

---

## Why this exists

An agent that talks to other agents has to answer one question before anything else:
_is the caller who they claim to be, and can they prove it without a shared secret?_
That answer — and the durable machinery for accepting a turn, decomposing it, and
delivering a result out of band — is identical for every agent. It is also the part
that is easy to get subtly and silently wrong.

So it ships once, here, with the security-critical paths pinned by tests. Anything
optional is a plugin. Anything opinionated belongs to your app.

---

## Quick start

### 1. Generate a signing key

```bash
npx looping-keys
```

Set the private JWK as `A2A_SIGNING_KEY` (`.dev.vars` locally, `wrangler secret put`
when deployed) and the origins you accept calls from as `GATEWAY_ORIGINS`:

```ini
# .dev.vars
A2A_SIGNING_KEY={"crv":"Ed25519","d":"…","x":"…","kty":"OKP","kid":"a2a-2026-08-01"}
GATEWAY_ORIGINS=["https://gateway.example.com"]
```

The public half is never configured anywhere — the Worker derives it from the private
key and serves it at the card's `jku`.

### 2. Put the A2A edge in front of your Durable Object

```ts
import { createA2AWorker } from "@loopingai/core/worker";

const manifest = {
  name: "my-agent",
  description: "Does a useful thing.",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: true, extensions: [] },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: []
};

export default {
  fetch: createA2AWorker({
    manifest,
    // One DO instance per verified caller — this is what makes a task
    // unreachable from any other caller by construction.
    resolveAgent: (identity) =>
      env.MY_AGENT.get(env.MY_AGENT.idFromName(identity.key!)),
    // Must be idempotent: the gateway retries dispatch.
    startTurn: async (turn) => {
      await env.TURN_WORKFLOW.create({ id: turn.messageId, params: turn });
    }
  })
} satisfies ExportedHandler<Env>;
```

That handler serves three routes: the public JWKS, a **signed** AgentCard at
`/.well-known/agent-card.json`, and gateway-authenticated JSON-RPC. Every POST is
verified before a Durable Object is ever addressed.

#### Several agents in one Worker

Every path is an option, so you can mount one handler per prefix behind your own router
and give each agent its own card, JWKS and Durable Object. Two options exist for that
case and only that case:

```ts
const proactive = createA2AWorker<Env>({
  manifest: proactiveManifest,
  rpcPath: "/proactive/a2a",
  jwksPath: "/proactive/.well-known/jwks.json",
  // Each mount signs with its own key — they share an `env`, so they cannot all
  // read `A2A_SIGNING_KEY`.
  secrets: (env) => ({
    signingKey: env.A2A_SIGNING_KEY_PROACTIVE,
    gatewayOrigins: env.GATEWAY_ORIGINS
  }),
  // …and requires its own audience, so a token minted for `/reactive` does not
  // verify here. Nothing leaks without it — the DO is still keyed by the verified
  // `identity.key` — but the origin stops identifying *which* agent a caller was
  // authorized to reach, and this is where that gets asked.
  audience: (url) => `${url.origin}/proactive`,
  resolveAgent,
  startTurn
});
```

Pass the request through unmodified — do not strip the prefix. The handler matches the
full `jwksPath` and the card path's suffix, so prefixed paths work with no rewriting, and
the card's `jku` stays resolvable. With one agent per Worker both options are unnecessary
and the defaults are exactly right.

### 3. Build the runtime in your Durable Object

Everything that would otherwise be a module-level constant is resolved once per DO
instance, from your config and your installed plugins:

```ts
import { Agent } from "agents";
import { createAgentRuntime } from "@loopingai/core";
import { AgentDB } from "@loopingai/core/db";

export class MyAgent extends Agent<Env> {
  runtime!: ReturnType<typeof createAgentRuntime>;
  db!: AgentDB;

  async onStart() {
    this.runtime = createAgentRuntime({
      config: { model: { chatModelId: "@cf/zai-org/glm-5.2" } },
      plugins: [scraper({ apiKey: this.env.SCRAPER_API_KEY })],
      env: this.env // opt in to verifying every plugin's declared bindings exist
    });

    this.db = new AgentDB(this.ctx.storage, {
      maxSubtasks: this.runtime.config.maxSubtasks,
      stores: this.runtime.stores
    });
    await this.db.ensureReady();
  }
}
```

Resolving a registry at _import_ time is the one thing this package exists to
prevent: it freezes the registry before `env` exists (which on Workers is always),
defeats tree-shaking, and makes runtime plugin selection impossible.

---

## Exports

No root barrel. Each area is its own subpath, so importing the delegation layer does
not drag in the A2A adapter, and the test harness cannot reach a production bundle.

| Subpath                        | What's in it                                                                |
| ------------------------------ | --------------------------------------------------------------------------- |
| `@loopingai/core`              | `createAgentRuntime`, the plugin contract, config shapes, platform facts    |
| `@loopingai/core/a2a`          | card signing, JWKS, gateway-JWT verify, push notify, task store, executor   |
| `@loopingai/core/worker`       | `createA2AWorker()` — the whole zero-trust edge                             |
| `@loopingai/core/agent`        | session, history, model runtime, inference, budget, control tools           |
| `@loopingai/core/subtasks`     | delegation types, decomposition, the `delegate` tool, wave scheduler        |
| `@loopingai/core/subagent`     | `RecipeSubagentBase`, resumable runs, fingerprinting, workspace             |
| `@loopingai/core/db`           | `AgentDB`, `notify_tasks` + `subtasks` schema, migrations, `PluginStore`    |
| `@loopingai/core/testing`      | VCR, `FakeSession`, `mockModel`, DO helpers, JWK fixtures — _workerd realm_ |
| `@loopingai/core/testing/node` | the VCR recorder — _Node realm, never import from a spec_                   |
| `@loopingai/core/eslint`       | the `no-deprecated-object-properties` rule                                  |

`/testing*` and `/eslint` are structurally incapable of entering a runtime graph, and
`npm run verify:exports` asserts exactly that before every publish.

---

## The zero-trust model

No secret ever crosses the boundary, in either direction.

```
Gateway ──── EdDSA JWT, jku → its public JWKS ────▶ Agent    "the agent knows the gateway"
Agent   ──── signed AgentCard, jku → its JWKS  ────▶ Gateway  "the gateway knows the agent"
```

`verifyGatewayToken` runs four checks, in this order, on every single call:

1. **`jku` present** in the protected header (RFC 7515 §4.1.2).
2. **`jku` origin is allowlisted** — validated _before_ the fetch, so an attacker
   cannot point `jku` at a JWKS they control.
3. **`iss` origin equals `jku` origin** — one listed gateway cannot impersonate another.
4. **`jwtVerify` pinned to EdDSA.**

All four are load-bearing. Do not make any of them optional, and do not add a
local-development bypass — run a local gateway instead. `verify.spec.ts` asserts each
one negatively, including that an unlisted `jku` is rejected _before_ any network
call happens.

The agent's card is signed over its **wire (protobuf-JSON) encoding**, which is what
makes the served document a fixed point under the repeated decoding a verifier
performs. A gateway pins the card's `kid` + `jku` on first registration
(Trust-On-First-Use).

---

## Plugins

A capability is a plugin. Core never imports one — your app registers it, which keeps
bundle size proportional to what you actually installed.

```ts
import { definePlugin } from "@loopingai/core";

export const scraper = (config: { apiKey: string }) =>
  definePlugin({
    key: "scraper",
    subtaskType: {
      key: "scrape",
      description: "fetch a page and summarize it",
      params: z.object({ url: z.string().describe("page to fetch") }),
      recipe
    },
    toolFamilies: { web: (ctx) => ({ tools: { fetchPage: /* … */ } }) },
    capability: "You can scrape a page and summarize it.",
    requires: { secrets: ["SCRAPER_API_KEY"] },
    store: { plugin: "scraper", version: 1, ensureTables: (sql, from) => { /* … */ } }
  });
```

`createAgentRuntime` fails at DO start — never mid-request — on a duplicate plugin
key, a duplicate tool family, a missing declared binding, or a
`PLUGIN_CONTRACT_VERSION` mismatch. Because core, plugins, and starter publish from
separate repos, one of them is always briefly behind; that version assert turns the
skew into a readable sentence instead of a structural-type error several frames from
its cause.

The contract is **additive-only within a major**: new capabilities arrive as optional
fields on `AgentPlugin`.

### Plugin-owned tables

A plugin owns its tables outright, through `store: PluginStore` — but it must stay out of
core's migration journal. `drizzle-orm/durable-sqlite/migrator` keeps one flat integer
journal and one global `__drizzle_migrations` table, and two independently-versioned
packages cannot share that index space.

That is a prohibition on exactly **one import**, not on drizzle. The query builder holds
no journal and no connection state, so a plugin declares its tables with `sqliteTable`,
writes idempotent DDL in `ensureTables`, and queries through its own handle:

```ts
export const scrapes = sqliteTable("scraper_scrapes", { url: text("url").primaryKey() });

store: {
  plugin: "scraper",
  version: 1,
  // Re-run on every hibernation wake-up, so it must be idempotent.
  ensureTables: (sql) => sql.exec(`CREATE TABLE IF NOT EXISTS scraper_scrapes (…)`)
}

// …and anywhere the plugin queries:
const db = drizzle(storage, { schema: { scrapes } });
```

Core records each store's version in a `plugin_migrations` row, so `ensureTables` receives
the version last seen on disk and an upgrade path can branch on it.

### Session hooks

`onMessagesDisplaced` hands over the raw messages a compaction is about to fold into a
summary. Core performs the compaction, so core announces the loss; it neither stores the
messages nor knows who wants them. An episodic-memory plugin, an audit log, and a
cold-storage dump all want exactly this callback, and each gets it:

```ts
// in your DO, wiring the runtime's fan-out into the session
buildAgentSession(this, model, {
  …,
  onMessagesDisplaced: this.runtime.onMessagesDisplaced
});
```

Best-effort in both directions — a listener that throws never aborts compaction (history
must still shorten when a side store is down), and the fan-out is `Promise.allSettled`, so
one plugin's outage cannot cost another its notification.

`shouldHandleTurn` is the other side of the session: a gate that decides whether a turn
runs at all, before the loop builds or calls anything. An agent that sees every message in
its channels is mostly seeing messages that are not for it, and asking a model already
trying to be helpful to stay quiet degrades _invisibly_ — failing to call a decline-tool
looks identical to deciding not to. Every declaring plugin is consulted and the answers are
AND-ed, so any one gate may decline.

```ts
if (!(await this.runtime.shouldHandleTurn({ history }))) return; // declined
```

It **fails open**: a gate that throws is counted as `true`. The two mistakes are not
symmetric — a wrong reply is noise the user can see and ignore, while a wrong silence is
invisible to the person who needed an answer.

### The workspace backend

Core declares the `WorkspaceBacking` shape and enforces the caps, but ships no backend —
the predecessor's was `@cloudflare/shell`, which is experimental, and an agent that never
delegates file work should not carry it. A plugin supplies one via `workspaceBacking`; at
most one may, and an agent that installs none gets `memoryWorkspaceBacking`. So
`runtime.workspaceBacking` is always defined and your `SubagentRuntime` never needs a null
check.

---

## Testing

The harness both predecessor agents grew, shipped so you don't grow it a third time.

```ts
import {
  FakeSession,
  mockModel,
  makeGatewayToken,
  makeDoHelpers
} from "@loopingai/core/testing";

const { withDb } = makeDoHelpers(env.MY_AGENT);

await withDb("accepts a turn once", async (db) => {
  await db.ensureReady();
  db.tasks.begin({ messageId: "m1", taskId: "t1", contextId: "c1" });
});
```

- **VCR** — record/replay real HTTP against on-disk cassettes, split across the Node
  and workerd realms because specs run in workerd, which has no filesystem. Point
  vitest's `globalSetup` at `@loopingai/core/testing/vcr-global-setup`.
- **Fakes** — `FakeSession` (a `SessionLike` reference implementation) and `mockModel`
  (a scripted `LanguageModel`), so a loop can be driven with no model call at all.
- **Fixtures** — Ed25519 keypairs and a gateway-JWT signer, so the zero-trust path is
  exercisable end to end without a real gateway.

---

## What core deliberately does _not_ contain

- The turn loop, triage, and the DO / Workflow class bodies. Core ships the argument
  and budget types; you write the loop.
- The main agent's soul. Core ships no prompt copy.
- Config _values_ — model ids, budgets, limits. Core ships the shapes and safe
  defaults, and `resolveConfig` validates your overrides.
- Vectorize recall, browser tools, shell. All optional → plugins. Core contains no
  embedding code at all: it ships the `onMessagesDisplaced` hook and nothing about what
  a listener does with the messages — no embedding model, no index, no dimension.

---

## Requirements

- **Node** ≥ 24 (for build and test only — the package itself runs on workerd)
- **Bindings:** `AI`, one Durable Object, one Workflow
- **Secrets:** `A2A_SIGNING_KEY`, `GATEWAY_ORIGINS`
- **Peers, never bundled:** `agents`, `ai`, `workers-ai-provider`

That last point is not stylistic: two copies of `agents` in one Worker breaks the
`Session` / `SessionMessage` types and every `instanceof`. For local development
across the three repos use `file:` overrides, or `npm pack` plus a tarball install —
**not `npm link`**, which duplicates peer dependencies.

---

## Contributing

[`AGENTS.md`](./AGENTS.md) documents the constraints this package is guardian of.

```bash
npm run check           # prettier + eslint + tsc (src) + tsc (test) + build
npm test                # vitest, inside real workerd
npm run verify:exports  # the publish gate: subpaths, ESM specifiers, realm isolation
```

## License

[GPL-3.0-only](./LICENSE).
