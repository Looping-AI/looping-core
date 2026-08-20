/**
 * Workers AI — core's default model provider.
 *
 * A provider rather than a capability: it ships no tools, no prompt copy and no
 * policy; it satisfies {@link file://../model.ts ModelRuntime} and stops.
 *
 * Two things about its shape are worth stating, because both look like
 * omissions:
 *
 * **No `LanguageModel` adapter.** `workers-ai-provider` ships one, so this
 * directory is a factory and nothing else — one file rather than the five a
 * hand-written adapter costs (a prompt mapping, a cache-control policy, an
 * error taxonomy). That is what makes it the cheap default.
 *
 * **No package subpath.** `workers-ai-provider` is a *required* peer and this is
 * the default every un-overridden seam reaches through `LoopingAgent` itself, so
 * it is in every consumer's module graph already and a subpath would buy
 * nothing. It is exported from `@loopingai/core/agent` — one symbol, one import
 * path. A provider behind an *optional* peer would want its own subpath instead,
 * so that an agent never calling it does not pay for it; `./anthropic` was one
 * until 0.8.0.
 */

export {
  createWorkersAIModelRuntime,
  workersAIModels,
  type WorkersAIRuntimeDeps
} from "./runtime.js";
