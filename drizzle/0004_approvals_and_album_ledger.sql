CREATE TABLE `approval_edits` (
	`approval_id` integer NOT NULL,
	`applied_edit_id` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_edits_pair` ON `approval_edits` (`approval_id`,`applied_edit_id`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_key` text NOT NULL,
	`message_id` text,
	`channel_id` text,
	`artist` text NOT NULL,
	`kind` text NOT NULL,
	`shared_field` text,
	`shared_from` text,
	`shared_to` text,
	`item_count` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`decided_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_group_key` ON `approvals` (`group_key`);--> statement-breakpoint
CREATE INDEX `approvals_status` ON `approvals` (`status`);--> statement-breakpoint
CREATE INDEX `approvals_message` ON `approvals` (`message_id`);--> statement-breakpoint
CREATE TABLE `ignored` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`artist` text NOT NULL,
	`title` text NOT NULL,
	`reason` text NOT NULL,
	`decided_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ignored_entity` ON `ignored` (`kind`,`artist`,`title`);--> statement-breakpoint
ALTER TABLE `applied_edits` ADD `kind` text DEFAULT 'track' NOT NULL;--> statement-breakpoint
ALTER TABLE `sweep_state` ADD `paused` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sweep_state` ADD `phase` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `sweep_state` ADD `candidates_done` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sweep_state` ADD `candidates_total` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sweep_state` ADD `updated_at` integer;