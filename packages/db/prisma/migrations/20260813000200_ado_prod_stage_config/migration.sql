-- Per-project configuration of which ADO release pipelines / stages count as a
-- PRODUCTION deploy, for DORA deploy frequency.
--
-- Needed because no name-based rule can separate an operational pipeline from a
-- deployment one. Shapes seen in real installs: 'Restart <region> Core Processor',
-- 'Reset IIS', 'Shutdown <service>' and 'Publish <Lib>Components'
-- (a NuGet publish) must not count, while 'Release-<App>.Dashboard.sln-Master'
-- must — and none of them carries a prod/production marker.
--
-- Both empty (the default) preserves today's behaviour: fall back to the name
-- heuristic in deploymentsUnion.
ALTER TABLE "azure_devops_project_syncs"
  ADD COLUMN IF NOT EXISTS "prod_release_definitions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "prod_stages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
