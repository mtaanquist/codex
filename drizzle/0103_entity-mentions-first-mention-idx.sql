DROP INDEX "entity_mentions_target_idx";--> statement-breakpoint
CREATE INDEX "entity_mentions_target_idx" ON "entity_mentions" USING btree ("target_type","target_id","source_id","position");