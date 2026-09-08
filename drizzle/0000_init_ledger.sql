CREATE TABLE `applied_edits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`track_name_original` text NOT NULL,
	`artist_name_original` text NOT NULL,
	`album_name_original` text NOT NULL,
	`album_artist_name_original` text NOT NULL,
	`track_name` text NOT NULL,
	`artist_name` text NOT NULL,
	`album_name` text NOT NULL,
	`album_artist_name` text NOT NULL,
	`groups` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`verified_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applied_edits_tuple` ON `applied_edits` (`track_name_original`,`artist_name_original`,`album_name_original`,`album_artist_name_original`);--> statement-breakpoint
CREATE INDEX `applied_edits_status` ON `applied_edits` (`status`);--> statement-breakpoint
CREATE TABLE `skipped` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`artist` text NOT NULL,
	`title` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skipped_entity` ON `skipped` (`kind`,`artist`,`title`);--> statement-breakpoint
CREATE TABLE `sweep_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_full_sweep_at` integer,
	`last_sweep_edit_count` integer DEFAULT 0 NOT NULL
);
