/**
 * `@loopingai/core/anthropic` — Claude as a second model provider.
 *
 * Its own subpath, and an **optional** peer dependency on `@anthropic-ai/sdk`,
 * for the same reason `/round` is not re-exported from the root barrel: an agent
 * that runs on Workers AI should not pay — in install size, in bundle bytes, or
 * in a dependency it must keep current — for a provider it never calls.
 *
 * What lives here is a provider, not a capability. It ships no tools, no prompt
 * copy and no policy; it satisfies {@link ModelRuntime} and stops.
 */

// Re-exported, not owned: a rejected credential is a fact about the path to a
// model, not about Anthropic, so the error lives with the rest of the provider
// contract in {@link file://../errors.ts}. An agent that only imports this
// subpath still gets it from one place.
export {
  CredentialRejectedError,
  type CredentialRejectedBy
} from "../errors.js";

export {
  createAnthropicLanguageModel,
  type AnthropicModelDeps
} from "./language-model.js";

export {
  createAnthropicModelRuntime,
  type AnthropicRuntimeDeps
} from "./runtime.js";

export { ANTHROPIC_PROVIDER, type CacheTtl } from "./prompt.js";
