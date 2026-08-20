-- When the Jira sync confirms an issue no longer resolves in Jira, the board row
-- keeps existing (its status turns to "Deleted") and this records when that was
-- established. NULL for every row whose issue is still live.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "jira_deleted_at" TIMESTAMP(3);

-- Deletion detection loads candidates per board; this keeps the "already known
-- deleted, skip the probe" check off a full scan on large boards.
CREATE INDEX IF NOT EXISTS "projects_jira_deleted_at_idx" ON "projects" ("jira_deleted_at");

-- Set only once the deleted issue's ClickHouse rows are gone. A row with
-- jira_deleted_at set and this NULL is a purge the next sync must retry.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "jira_analytics_purged_at" TIMESTAMP(3);
