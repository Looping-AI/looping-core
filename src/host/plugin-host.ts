/**
 * Everything a plugin may need from its host, resolved once per Durable Object
 * instance.
 *
 * This is **contract, not application code**, which is why it lives in core. A
 * published plugin's config is written against this shape — `arcAgi` takes
 * `storage`, `recall` takes `callerKey` — so a plugin that could not name the
 * type was writing its signature against a structural guess at an interface
 * declared in an app it has never seen.
 *
 * Not just `env`, and each field is load-bearing:
 *
 * - `env` — bindings and secrets. Typed `object` for the same reason
 *   {@link file://../runtime/index.ts CreateAgentRuntimeOptions.env} is: `Env` is
 *   the ambient interface `wrangler types` generates into a consumer's
 *   `worker-configuration.d.ts`, it has no index signature, and requiring a cast
 *   to pass one's own `this.env` is how a seam goes unused. A host narrows it.
 * - `storage` — a plugin that owns tables needs the DO's storage to build a query
 *   handle over. `this.ctx.storage`.
 * - `callerKey` — **a thunk, deliberately.** It derives from the verified
 *   caller's identity, which does not exist yet when `plugins()` runs at DO
 *   start. The DO is keyed 1:1 by that caller, so the value is constant once
 *   known; a thunk is what lets the host supply it late while every hook reads
 *   the same one. On a subagent facet there is no caller at all, and the honest
 *   encoding is a thunk that throws.
 * - the model ids — what a locally-declared recipe runs on. A recipe may only
 *   name models in the host's allowlist, so a plugin that ships one is handed the
 *   host's pair rather than guessing.
 * - `aiGatewayId` — the **resolved** AI Gateway slug, so a plugin making its own
 *   model calls is correlated with the agent's. Resolved, not read off the
 *   overrides object: reaching into `MY_CONFIG.model?.aiGatewayId` at a call site
 *   silently yields `undefined` the moment that override is dropped in favour of
 *   core's default, and the plugin's calls quietly stop being correlated.
 */
export interface PluginHost<TEnv extends object = object> {
  env: TEnv;
  storage: DurableObjectStorage;
  /** The verified caller. A thunk — it does not exist when `onStart` runs. */
  callerKey: () => string;
  /** `config.model.chatModelId` — what a locally-declared recipe runs on. */
  primaryModelId: string;
  /** `config.model.fallbackChatModelId`. */
  fallbackModelId: string;
  /** `config.model.aiGatewayId`, already resolved over core's defaults. */
  aiGatewayId: string;
}
