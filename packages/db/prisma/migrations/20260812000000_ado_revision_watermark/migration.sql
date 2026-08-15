-- Watermark for the ADO Reporting Work Item Revisions sweep.
--
-- The sweep that builds `ado_transitions` previously ran with no `startDateTime`,
-- so every scheduled run re-read the complete revision history of every project
-- (~256k revisions per cycle across one large org, every 15 minutes). That
-- is what exhausted the account's Azure DevOps throughput budget and got its
-- requests delayed. This column lets each project resume from where it left off.
--
-- Deliberately left NULL on existing rows: the first run after this migration
-- performs one final full sweep per project, which also establishes the prior
-- state that later incremental runs read back from ClickHouse.
ALTER TABLE "azure_devops_project_syncs"
  ADD COLUMN "last_revision_sync_at" TIMESTAMP(3);
