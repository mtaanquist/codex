-- One-off repair for editions hidden by an account deletion scheduled before
-- 0124 added hidden_by_account_deletion (default false, no backfill). An
-- edition that is down without a takedown reason was hidden by account
-- deletion (or by a takedown from before reasons existed), and every edition
-- of an owner whose deletion is still pending was hidden by it, even one
-- taken down too. Restoring a later takedown must keep these down. Only
-- those rows change.
UPDATE "publications" SET "hidden_by_account_deletion" = true
WHERE NOT "hidden_by_account_deletion"
	AND (
		("removed_at" IS NOT NULL AND "removed_reason" IS NULL)
		OR "owner_id" IN (SELECT "id" FROM "users" WHERE "deletion_scheduled_at" IS NOT NULL)
	);
