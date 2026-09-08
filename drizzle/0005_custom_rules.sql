CREATE TABLE `custom_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`artist` text NOT NULL,
	`from_title` text NOT NULL,
	`to_title` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_applied_at` integer,
	`times_applied` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_rules_entity` ON `custom_rules` (`kind`,`artist`,`from_title`);