CREATE TABLE `shadow_hits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`would_be` text NOT NULL,
	`source_artist` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer,
	`reported_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shadow_hits_entity` ON `shadow_hits` (`rule`,`kind`,`title`);--> statement-breakpoint
CREATE INDEX `shadow_hits_unreported` ON `shadow_hits` (`reported_at`);