-- Watermark for real ADO deployment records (classic Release pipeline
-- deployments → cockpit.ado_deployments), which DORA's deploy frequency prefers
-- over the merged-PR proxy.
--
-- Lives on the project sync, not ado_repo_sync_states: release pipelines belong
-- to a project, not a repo, and they are served from a different host
-- (vsrm.dev.azure.com), so this stream must not be tied to the per-repo PR /
-- commit pass or its watermarks.
ALTER TABLE "azure_devops_project_syncs"
  ADD COLUMN IF NOT EXISTS "last_deployment_sync_at" TIMESTAMP(3);
