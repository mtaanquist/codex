CREATE TABLE "embedding_indexes" (
	"user_id" uuid NOT NULL,
	"universe_id" uuid NOT NULL,
	"model" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_indexes_user_id_universe_id_pk" PRIMARY KEY("user_id","universe_id")
);
--> statement-breakpoint
CREATE TABLE "scene_chunks" (
	"scene_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" vector NOT NULL,
	"scene_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scene_chunks_scene_id_chunk_index_pk" PRIMARY KEY("scene_id","chunk_index")
);
--> statement-breakpoint
ALTER TABLE "embedding_indexes" ADD CONSTRAINT "embedding_indexes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_indexes" ADD CONSTRAINT "embedding_indexes_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_chunks" ADD CONSTRAINT "scene_chunks_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "embedding_indexes_universe_idx" ON "embedding_indexes" USING btree ("universe_id");--> statement-breakpoint
CREATE TRIGGER "clear_asset_marks" AFTER INSERT OR UPDATE ON "embedding_indexes" FOR EACH ROW EXECUTE FUNCTION "clear_asset_marks"();--> statement-breakpoint
CREATE TRIGGER "clear_asset_marks" AFTER INSERT OR UPDATE ON "scene_chunks" FOR EACH ROW EXECUTE FUNCTION "clear_asset_marks"();
