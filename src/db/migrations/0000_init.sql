CREATE TABLE `notify_tasks` (
	`task_id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`context_id` text DEFAULT '' NOT NULL,
	`state` text NOT NULL,
	`task_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notify_tasks_message_id_unique` ON `notify_tasks` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_notify_tasks_created_at` ON `notify_tasks` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_notify_tasks_context` ON `notify_tasks` (`context_id`);--> statement-breakpoint
CREATE INDEX `idx_notify_tasks_state` ON `notify_tasks` (`state`);--> statement-breakpoint
CREATE TABLE `subtasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`round` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`type` text NOT NULL,
	`recipe_id` text,
	`recipe_version` integer,
	`prompt` text NOT NULL,
	`references_json` text NOT NULL,
	`depends_on_json` text NOT NULL,
	`params_json` text DEFAULT '{}' NOT NULL,
	`status` text NOT NULL,
	`result_parts_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_subtasks_task_ordinal` ON `subtasks` (`task_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_subtasks_task_round` ON `subtasks` (`task_id`,`round`);--> statement-breakpoint
CREATE INDEX `idx_subtasks_status` ON `subtasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_subtasks_created_at` ON `subtasks` (`created_at`);