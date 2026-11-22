ALTER TABLE "assistant_drafts" ADD COLUMN "chapter_brief" text;--> statement-breakpoint
ALTER TABLE "assistant_drafts" ADD COLUMN "save_source" text;--> statement-breakpoint
ALTER TABLE "assistant_drafts" ADD COLUMN "save_seq" integer;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "save_source" text;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "save_seq" integer;