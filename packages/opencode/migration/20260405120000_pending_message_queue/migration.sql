CREATE TABLE `pending_message` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`source` text,
	`created_against_execution_id` text,
	`supersedes_execution_id` text,
	`error` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_pending_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `pending_message_session_position_idx` ON `pending_message` (`session_id`,`position`);
--> statement-breakpoint
CREATE INDEX `pending_message_session_status_idx` ON `pending_message` (`session_id`,`status`);
