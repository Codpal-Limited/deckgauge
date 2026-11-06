-- Bitbucket Cloud deployments (Pipelines → Deployments), the source of REAL
-- DORA deploy frequency for Bitbucket — GitLab only has the merged-PR proxy.
--
-- One row per deployment record, i.e. per (pipeline run × environment). A single
-- release fans out to many per-brand environments, so a row is NOT a deploy:
-- deploymentsUnion counts one deploy per (repo_full_name, pipeline_uuid) with at
-- least one successful Production-type environment, deployed_at = the earliest
-- completion, release_key = 'bb#' || pipeline_uuid. That verdict is made at QUERY
-- time, never stored here, for the reason 35_ado_deployments_drop_is_production
-- records: a row fetched once can never have a stored verdict revised.
--
-- Born tenant-keyed — see 70_bitbucket_pull_requests.sql.
CREATE TABLE IF NOT EXISTS cockpit.bitbucket_deployments
(
    organization_id     String,
    id                  String,            -- "{repo_full_name}#{deployment_uuid}"
    deployment_uuid     String,
    repo_full_name      String,
    instance_id         String,
    environment_uuid    String,
    environment_name    String,            -- e.g. 'Production_Aloplay_clubgcc'
    environment_type    String,            -- Production | Staging | Test
    state               String,            -- state.name: COMPLETED | IN_PROGRESS | UNDEPLOYED
    status              String           DEFAULT '', -- state.status.name: SUCCESSFUL | FAILED | STOPPED
    pipeline_uuid       String           DEFAULT '',
    commit_sha          String           DEFAULT '',
    started_at          Nullable(DateTime),
    completed_at        Nullable(DateTime),
    synced_at           DateTime         DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
-- Both timestamps are Nullable and cannot be partitioned on directly (same rule
-- as 34_ado_deployments.sql).
PARTITION BY toYYYYMM(coalesce(started_at, toDateTime(0)))
ORDER BY (organization_id, repo_full_name, deployment_uuid)
SETTINGS index_granularity = 8192;
