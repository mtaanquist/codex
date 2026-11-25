-- One-off repair of tag merges left by data from before every merge was kept
-- one step deep. Reads and mergeTag follow merged_into_id at most 8 steps
-- (MAX_MERGE_DEPTH in src/lib/server/tags.ts), so a loop or a longer chain
-- never reaches a surviving entry. Only those rows change; a chain that ends
-- within 8 steps is left as it is.
--
-- First, each loop gets a survivor: its oldest entry (by created_at, then id)
-- stops being merged, and the rest of the loop now ends at it.
WITH RECURSIVE "walk" AS (
	SELECT t."id" AS "start_id", t."merged_into_id" AS "next_id", ARRAY[t."id"] AS "path"
	FROM "tags" t WHERE t."merged_into_id" IS NOT NULL
	UNION ALL
	SELECT w."start_id", t."merged_into_id", w."path" || t."id"
	FROM "walk" w JOIN "tags" t ON t."id" = w."next_id"
	WHERE NOT t."id" = ANY(w."path")
)
UPDATE "tags" SET "merged_into_id" = NULL
WHERE "id" IN (
	SELECT (
		SELECT p."id" FROM "tags" p WHERE p."id" = ANY(w."path")
		ORDER BY p."created_at", p."id" LIMIT 1
	)
	FROM "walk" w WHERE w."next_id" = w."start_id"
);--> statement-breakpoint
-- Then every entry more than 8 steps from its survivor points at it directly.
WITH RECURSIVE "walk" AS (
	SELECT t."id" AS "start_id", t."merged_into_id" AS "next_id", ARRAY[t."id"] AS "path"
	FROM "tags" t WHERE t."merged_into_id" IS NOT NULL
	UNION ALL
	SELECT w."start_id", t."merged_into_id", w."path" || t."id"
	FROM "walk" w JOIN "tags" t ON t."id" = w."next_id"
	WHERE NOT t."id" = ANY(w."path")
)
UPDATE "tags" t SET "merged_into_id" = w."path"[cardinality(w."path")]
FROM "walk" w
WHERE t."id" = w."start_id" AND w."next_id" IS NULL AND cardinality(w."path") > 9;
