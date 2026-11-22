ALTER TABLE "assistant_drafts" ADD COLUMN "source" text DEFAULT 'assistant' NOT NULL;--> statement-breakpoint
-- Before this column an app's draft was told apart by having no job; the
-- Assistant has written its job id with the row since drafts shipped. Only
-- rows that also carry an app's "Drafted by" note are marked, so an imported
-- draft of the Assistant's stays the Assistant's.
UPDATE "assistant_drafts" SET "source" = 'app' WHERE "job_id" IS NULL AND "note" LIKE 'Drafted by %';
