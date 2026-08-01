import type { SubtaskId, SubtaskNode, SubtaskStatus } from "./types.js";

/**
 * The Phase 2 wave scheduler: given the DAG's current state, decide what runs
 * next.
 *
 * Pure and non-mutating. Skipping nodes blocked by a failed prerequisite is the
 * parent's job (`skipBlockedSubtasks`, which runs to a fixpoint and owns the
 * durable writes); this only reads statuses and picks a wave. The Workflow calls
 * it between durable steps, so it must be a plain function of its input — no I/O,
 * no clock, no randomness.
 */

/** What the Workflow should do with the DAG as it currently stands. */
export type WaveDecision =
  /** These nodes' prerequisites all succeeded — run them concurrently, now. */
  | { kind: "ready"; ids: SubtaskId[] }
  /** Every node reached a terminal status. Phase 2 is over. */
  | { kind: "done" }
  /** Non-terminal nodes remain but none can ever run. An invariant violation. */
  | { kind: "stuck"; active: SubtaskId[] };

/**
 * Non-terminal statuses — nodes Phase 2 still owes an outcome for.
 *
 * `running` counts as active on purpose. `executeSubtask` accepts a row that is
 * `pending` **or** `running`: the latter is its ambiguous-retry path, where a
 * previous attempt crashed mid-execution and the managed child's fingerprint
 * cache may still hold the terminal result that makes the retry free. So a row
 * stranded `running` is re-runnable, and treating it as inert would deadlock its
 * dependents instead of recovering them.
 */
const ACTIVE: ReadonlySet<SubtaskStatus> = new Set<SubtaskStatus>([
  "pending",
  "running"
]);

/**
 * Select the next wave of dependency-ready Subtasks.
 *
 * A node is ready when it is still active and **every** dependency completed
 * successfully — `completed` specifically, not merely terminal: a dependent must
 * never run on a failed prerequisite's absent output.
 *
 * Ready ids come back in `ordinal` order. The Workflow builds durable step names
 * from them (`execute:<id>`), and step names are a cache key, so the traversal
 * that produces them has to be deterministic.
 *
 * **On `stuck`:** one "active nodes, none ready" check is the whole safety net. A
 * cycle, a self-dependency, and a dangling dependency id all manifest identically
 * here — every node in a cycle waits on a non-completed peer, a self-dependency
 * waits on its own non-completed self, and an unknown id resolves to `undefined`,
 * which is not `completed`. None of them are reachable: `createDecomposition`
 * validates the DAG before it persists a single row. So this is a loud assertion
 * for a corrupted DAG, not a control path — which is exactly why it is one check
 * and not three detectors that can never fire.
 */
export function selectWave(nodes: SubtaskNode[]): WaveDecision {
  const statusById = new Map(nodes.map((n) => [n.id, n.status]));
  const active = nodes.filter((n) => ACTIVE.has(n.status));
  if (active.length === 0) return { kind: "done" };

  const ready = active
    .filter((n) => n.dependsOn.every((d) => statusById.get(d) === "completed"))
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((n) => n.id);

  if (ready.length === 0)
    return { kind: "stuck", active: active.map((n) => n.id) };
  return { kind: "ready", ids: ready };
}
