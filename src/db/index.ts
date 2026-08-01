/**
 * `@looping/core/db` — the two tables core owns, and the seam a plugin uses to
 * own its own without touching core's migration journal.
 */

export {
  AgentDB,
  PLUGIN_MIGRATIONS_TABLE,
  type AgentDBOptions,
  type DB,
  type PluginStore
} from "./db.js";

export { notifyTasks, subtasks } from "./schema.js";

export { makeTasks, stateOf, type TaskListQuery } from "./models/tasks.js";

export { makeSubtasks, type SubtaskModelOptions } from "./models/subtasks.js";
