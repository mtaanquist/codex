ALTER TABLE "publications" ADD COLUMN "restored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "restored_by" uuid;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "browse_allowed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "browse_allowed_by" uuid;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_restored_by_users_id_fk" FOREIGN KEY ("restored_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_browse_allowed_by_users_id_fk" FOREIGN KEY ("browse_allowed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;