CREATE TABLE `library` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`artist` text NOT NULL,
	`title` text NOT NULL,
	`album_title` text,
	`album_artist` text,
	`playcount` integer DEFAULT 0 NOT NULL,
	`album_source` text,
	`mapped_at` integer,
	`map_attempts` integer DEFAULT 0 NOT NULL,
	`map_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_entity` ON `library` (`kind`,`artist`,`title`);--> statement-breakpoint
CREATE INDEX `library_album` ON `library` (`album_artist`,`album_title`);--> statement-breakpoint
CREATE INDEX `library_playcount` ON `library` (`playcount`);