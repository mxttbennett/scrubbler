CREATE TABLE `dead_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`artist` text NOT NULL,
	`title` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`reason` text NOT NULL,
	`last_tried_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dead_candidates_entity` ON `dead_candidates` (`kind`,`artist`,`title`);--> statement-breakpoint
ALTER TABLE `sweep_state` ADD `last_scrobble_uts` integer;