ALTER TABLE "stories" ADD COLUMN "assistant_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "assistant_notes" text;--> statement-breakpoint
ALTER TABLE "universes" ADD COLUMN "assistant_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "universes" ADD COLUMN "assistant_notes" text;