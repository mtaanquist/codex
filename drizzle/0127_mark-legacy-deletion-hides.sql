-- One-off repair for editions hidden by an account deletion scheduled before
-- 0124 added hidden_by_account_deletion (default false, no backfill). An
-- edition that is down without a takedown reason was hidden by account
-- deletion (or by a takedown from before reasons existed), so restoring a
-- later takedown must keep it down. Only those rows change.
UPDATE "publications" SET "hidden_by_account_deletion" = true
WHERE "removed_at" IS NOT NULL
	AND "removed_reason" IS NULL
	AND NOT "hidden_by_account_deletion";
