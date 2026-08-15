-- Backward-walking backfill cursors for ADO code intelligence.
--
-- last_pr_sync_at / last_commit_sync_at only ever move forward, so once they
-- have advanced past a hole in history (rows lost to a ClickHouse partition
-- drop, or a first run that never completed) nothing re-reads it. These columns
-- record how far back history has been filled; each sync run pulls one bounded
-- chunk older than the cursor and moves it further back until it hits the
-- configured floor. NULL = backfill not started for that stream.
ALTER TABLE "ado_repo_sync_states"
  ADD COLUMN IF NOT EXISTS "pr_backfilled_until" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "commit_backfilled_until" TIMESTAMP(3);
