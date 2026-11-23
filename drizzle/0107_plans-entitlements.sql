CREATE TABLE "entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlements_plan_key" UNIQUE("plan_id","key")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_one_default_idx" ON "plans" USING btree ("is_default") WHERE "plans"."is_default";--> statement-breakpoint
-- Nothing wrote plan_id before this table existed; clear any stray value so
-- the constraint below can land.
UPDATE "users" SET "plan_id" = NULL WHERE "plan_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The default plan has no entitlement rows, so it sets no limits.
INSERT INTO "plans" ("key", "name", "is_default") VALUES ('default', 'Default', true);--> statement-breakpoint
-- storage_used_bytes was never maintained before; start it from the assets
-- each account owns. recountStorageUsed in quotas.ts runs the same sum.
UPDATE "users" u SET "storage_used_bytes" = a."total"
FROM (SELECT "owner_id", sum("byte_size")::bigint AS "total" FROM "assets" GROUP BY "owner_id") a
WHERE a."owner_id" = u."id" AND u."storage_used_bytes" <> a."total";
