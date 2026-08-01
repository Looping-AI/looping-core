import { runInDurableObject } from "cloudflare:test";
import { AgentDB, type AgentDBOptions } from "../db/db.js";

/**
 * Durable Object test helpers.
 *
 * The predecessor hardcoded its own DO binding and exposed one `with*` wrapper
 * per named `AgentDB` domain — including one for a domain that belonged to a
 * plugin. Both are parameterized here: a consumer binds their namespace once,
 * and {@link DoTestHelpers.withDb} hands over the whole `AgentDB` rather than
 * pre-selecting a table.
 */

export interface DoTestHelpers {
  /** Fresh, unique DO stub per test — state never leaks between tests. */
  freshStub(label: string): DurableObjectStub;
  /** Run `fn` inside a fresh DO instance with a migrated {@link AgentDB}. */
  withDb<T>(label: string, fn: (db: AgentDB) => T): Promise<T>;
}

/**
 * `ctx` is protected in the DO type system but public at runtime. Cast once so
 * callers don't repeat the assertion.
 */
export function doStorage(instance: unknown): DurableObjectStorage {
  return (instance as { ctx: { storage: DurableObjectStorage } }).ctx.storage;
}

/**
 * Bind the helpers to a consumer's DO namespace.
 *
 * ```ts
 * const { freshStub, withDb } = makeDoHelpers(env.MyAgent);
 * ```
 */
export function makeDoHelpers(
  ns: DurableObjectNamespace,
  defaults: AgentDBOptions = { maxSubtasks: 8 }
): DoTestHelpers {
  const freshStub = (label: string) =>
    ns.get(ns.idFromName(`test:${label}:${crypto.randomUUID()}`));

  return {
    freshStub,
    withDb<T>(label: string, fn: (db: AgentDB) => T): Promise<T> {
      return runInDurableObject(freshStub(label), (instance) =>
        fn(new AgentDB(doStorage(instance), defaults))
      );
    }
  };
}
