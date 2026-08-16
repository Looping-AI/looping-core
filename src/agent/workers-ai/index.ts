/**
 * Workers AI — core's default model provider.
 *
 * A sibling of {@link file://../anthropic/index.ts `./anthropic`}, and like it a
 * provider rather than a capability: it ships no tools, no prompt copy and no
 * policy; it satisfies {@link file://../model.ts ModelRuntime} and stops.
 *
 * It differs from that sibling in two ways, both deliberate:
 *
 * **No `LanguageModel` adapter.** `workers-ai-provider` ships one, so this
 * directory is a factory and nothing else. The Anthropic side hand-builds the
 * adapter — the prompt mapping, the cache control, the error taxonomy — which is
 * why it is five files and this is one.
 *
 * **No package subpath.** `/anthropic` has one because `@anthropic-ai/sdk` is an
 * *optional* peer and an agent on Workers AI must not pay for a provider it
 * never calls. That argument does not apply here: `workers-ai-provider` is a
 * required peer, and this is the default every un-overridden seam reaches
 * through `LoopingAgent` itself, so it is in every consumer's module graph
 * already. It is exported from `@loopingai/core/agent` — one symbol, one import
 * path.
 */

export {
  createWorkersAIModelRuntime,
  workersAIModels,
  type WorkersAIRuntimeDeps
} from "./runtime.js";
