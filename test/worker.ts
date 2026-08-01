import { Agent } from "agents";
import { AgentDB, type AgentDBOptions } from "../src/db/db.js";
import {
  RecipeSubagentBase,
  type SubagentRuntime
} from "../src/subagent/index.js";

/**
 * The Worker under test.
 *
 * `@loopingai/core` is a library, not a Worker — but its Durable Object pieces
 * (`AgentDB` migrations, the subagent facet's own SQLite) can only be exercised
 * inside workerd. So this file is the minimal host that gives the pool something
 * to bind: a DO that owns an `AgentDB`, and a concrete subclass of the facet.
 *
 * It is deliberately thin. Anything richer belongs in `looping-starter`, where a
 * real agent is the thing being tested rather than the harness.
 */

export class TestAgent extends Agent<Cloudflare.Env> {
  private _db?: AgentDB;

  db(options: AgentDBOptions = { maxSubtasks: 8 }): AgentDB {
    return (this._db ??= new AgentDB(this.ctx.storage, options));
  }

  /** Reset the memoized handle so a test can rebuild with different options. */
  resetDb(): void {
    this._db = undefined;
  }
}

/**
 * A concrete facet for the tests. The runtime is injected per test through
 * {@link setSubagentRuntime} rather than built from `env`, because what varies
 * across the subagent specs *is* the runtime.
 */
let testRuntime: SubagentRuntime | undefined;

export function setSubagentRuntime(runtime: SubagentRuntime): void {
  testRuntime = runtime;
}

export class TestSubagent extends RecipeSubagentBase<Cloudflare.Env> {
  protected subagentRuntime(): SubagentRuntime {
    if (!testRuntime) {
      throw new Error(
        "test subagent runtime not set — call setSubagentRuntime"
      );
    }
    return testRuntime;
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("looping-core test worker");
  }
} satisfies ExportedHandler<Cloudflare.Env>;
