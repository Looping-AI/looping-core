import {
  taskStateToJSON,
  type Role,
  type Task,
  type TaskState
} from "@a2a-js/sdk";

/**
 * The A2A `Task` (and its nested types) as they cross the DO RPC boundary.
 *
 * Two constraints shape these, and the SDK types satisfy neither directly:
 *
 *  1. **Serializability.** A v1.0 `Part` carries a `content` oneof whose `raw`
 *     arm is a `Buffer`; its methods fail Cloudflare's `Rpc.Serializable`
 *     constraint and collapse the generated DO-stub return types to `never`.
 *     Pinning `content` to its `text` arm removes that arm — and this agent only
 *     ever produces, and only ever receives, text (see {@link file://./parts.ts}).
 *  2. **Instantiation depth.** These are written out as plain interfaces rather
 *     than derived with `Omit<Task, …> & { … }`. The v1.0 model is deep enough
 *     that layering mapped types under Cloudflare's own RPC type mapping exceeds
 *     TypeScript's instantiation limit at the stub call sites.
 *
 * Each of these widens to its SDK counterpart for free, so no cast is needed at
 * the a2a-js edges (`AgentEvent.task`, `TaskStore.load`/`list`); the
 * {@link _Widens} guard below fails the build if that ever stops holding.
 * Runtime is unaffected — tasks are JSON-round-tripped in storage, so any field
 * the SDK adds survives even though these types don't name it.
 */

/**
 * The A2A extension `metadata` bag as this agent handles it: never set. Its SDK
 * type is an open `{ [key: string]: any }` map, which is both what collapses the
 * DO-stub types (`unknown` members fail `Rpc.Serializable`) and what pushes the
 * stub-mapped `Task` past TypeScript's instantiation limit. Pinning it to
 * `undefined` keeps both in check and still widens to the SDK type. Metadata a
 * caller sent is not erased — stored tasks are JSON blobs, so it round-trips
 * untouched; it is simply invisible to this agent, which never reads it.
 */
type A2AMetadata = undefined;

/** A `Part` restricted to the text arm of its `content` oneof. */
export interface PlainPart {
  content: { $case: "text"; value: string };
  metadata: A2AMetadata;
  filename: string;
  mediaType: string;
}

/** A `Message` whose parts are all {@link PlainPart}. */
export interface PlainMessage {
  messageId: string;
  contextId: string;
  taskId: string;
  role: Role;
  parts: PlainPart[];
  metadata: A2AMetadata;
  extensions: string[];
  referenceTaskIds: string[];
}

/** An `Artifact` whose parts are all {@link PlainPart}. */
export interface PlainArtifact {
  artifactId: string;
  name: string;
  description: string;
  parts: PlainPart[];
  metadata: A2AMetadata;
  extensions: string[];
}

/** A `TaskStatus` whose message is a {@link PlainMessage}. */
export interface PlainStatus {
  state: TaskState;
  message: PlainMessage | undefined;
  timestamp: string | undefined;
}

/** A `Task` built entirely from the plain types above. */
export interface PlainTask {
  id: string;
  contextId: string;
  status: PlainStatus;
  artifacts: PlainArtifact[];
  history: PlainMessage[];
  metadata: A2AMetadata;
}

// Compile-time guard: `PlainTask` must stay a structural subtype of the SDK `Task`
// so it widens with no cast at the a2a-js boundaries. Fails the build otherwise.
type _Widens = PlainTask extends Task ? true : never;
const _assertWidens: _Widens = true;
void _assertWidens;

/**
 * A task state rendered for humans and for the `notify_tasks.state` column
 * (`TASK_STATE_INPUT_REQUIRED` → `input-required`). v1.0 states are numeric enum
 * members, so anything stored or displayed goes through the protobuf JSON name
 * first. Matches slack-gatekeeper's `taskStateLabel`.
 */
export function taskStateLabel(state: TaskState): string {
  return taskStateToJSON(state)
    .replace(/^TASK_STATE_/, "")
    .toLowerCase()
    .replace(/_/g, "-");
}
