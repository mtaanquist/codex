CREATE TABLE "story_tags" (
	"story_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "story_tags_story_id_tag_id_pk" PRIMARY KEY("story_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"merged_into_id" uuid,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "content_warnings" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "story_tags" ADD CONSTRAINT "story_tags_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_tags" ADD CONSTRAINT "story_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_merged_into_id_tags_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."tags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "story_tags_tag" ON "story_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_kind_slug" ON "tags" USING btree ("kind","slug");--> statement-breakpoint
CREATE TRIGGER "clear_asset_marks" AFTER INSERT OR UPDATE ON "tags" FOR EACH ROW EXECUTE FUNCTION "clear_asset_marks"();--> statement-breakpoint
CREATE TRIGGER "clear_asset_marks" AFTER INSERT OR UPDATE ON "story_tags" FOR EACH ROW EXECUTE FUNCTION "clear_asset_marks"();
