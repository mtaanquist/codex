CREATE TABLE "publication_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" text
);
--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "removed_reason" text;--> statement-breakpoint
ALTER TABLE "publication_reports" ADD CONSTRAINT "publication_reports_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_reports" ADD CONSTRAINT "publication_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publication_reports_open" ON "publication_reports" USING btree ("created_at") WHERE "publication_reports"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "publication_reports_publication" ON "publication_reports" USING btree ("publication_id");