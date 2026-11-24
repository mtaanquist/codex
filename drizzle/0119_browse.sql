ALTER TABLE "stories" ADD COLUMN "listed_in_browse" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "browse_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "browse_blocked_reason" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "browse_blocked_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "hidden_from_browse" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_browse_blocked_by_users_id_fk" FOREIGN KEY ("browse_blocked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;