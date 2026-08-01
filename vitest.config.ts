import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * Specs run **inside workerd**, not Node.
 *
 * That is not a preference: `AgentDB` drives `ctx.storage.sql` and the Agents
 * SDK's `Session`, neither of which has a Node-side implementation to stand in
 * for. So the pool boots the real runtime with the Durable Objects declared in
 * `wrangler.jsonc`, and `test/worker.ts` is the host that owns them.
 *
 * The one thing that cannot run in there is the VCR recorder, which needs
 * `node:fs` to read and write cassettes. It runs in the Node realm as
 * `globalSetup` instead, and the spec side reaches it over the in-band control
 * channel — see `src/testing/vcr-shared.ts` for why the two halves must never
 * share a module graph.
 *
 * Note this is `@cloudflare/vitest-pool-workers` 0.18's plugin API
 * (`cloudflareTest()` returning a Vite plugin), not the `defineWorkersConfig`
 * wrapper the older docs show — that export no longer exists.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      // `main` and every binding come from the one wrangler config, so the
      // test host and a real deploy can never drift apart.
      wrangler: { configPath: "./wrangler.jsonc" }
    })
  ],
  test: {
    // Node realm. Flushes cassettes and stops the recorder after the run;
    // without it a `RECORD=1` run hangs on open sockets.
    globalSetup: ["./src/testing/vcr-global-setup.ts"],
    include: ["src/**/*.spec.ts", "test/**/*.spec.ts"]
  }
});
