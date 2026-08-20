-- clickhouse/schemas/34_ado_deployments.sql
--
-- Real Azure DevOps deployment records — the source DORA's deploy frequency
-- reads instead of the merged-PR proxy (see packages/shared/src/dora.ts).
--
-- `kind` keeps the table unified across ADO's two deployment mechanisms:
--   'release'     — classic Release pipelines, from
--                   vsrm.dev.azure.com/{org}/{project}/_apis/release/deployments.
--                   This is the mechanism real orgs actually use (probing live
--                   APIs found 5 release definitions in one org, 4 in another)
--                   and it is the only one reachable today.
--   'environment' — multi-stage YAML pipeline deployments, from
--                   distributedtask/environments/{id}/environmentdeploymentrecords.
--                   NOT ingested yet: that endpoint needs a PAT with Environment
--                   (read) scope, which the current token lacks — it answers with
--                   an auth redirect rather than JSON. The column exists so that
--                   source can be added without a migration.
--
-- Deliberately NOT modelled as a deployment: Build/pipeline *runs*
-- (/_apis/build/builds). A build succeeding is not a deploy — a single large org
-- can carry 55k+ builds, and counting them would inflate deploy frequency far
-- worse than the merged-PR proxy it replaces.
CREATE TABLE IF NOT EXISTS cockpit.ado_deployments
(
    organization_id     String,
    id                  String,            -- "{org_url}/{project}#{kind}#{deployment_id}"
    deployment_id       UInt64,
    kind                String,            -- 'release' | 'environment'
    org_url             String,
    project             String,
    instance_id         String,
    -- Release pipeline identity (definition = the pipeline, release = one run of it).
    definition_id       UInt32           DEFAULT 0,
    definition_name     String           DEFAULT '',
    release_id          UInt32           DEFAULT 0,
    release_name        String           DEFAULT '',
    environment         String,            -- stage / environment name, e.g. 'Production'
    -- NOTE: there is deliberately no is_production column. Whether a deployment
    -- reached production is decided at QUERY time, in deploymentsUnion
    -- (apps/api/src/widgets/unions.ts), from environment / definition_name /
    -- source_branch plus any per-project override. A row is fetched exactly once
    -- (the watermark never re-reads it), so a verdict stored here could never be
    -- revised — the same trap that once froze ado_pull_requests as 'active'.
    -- See 35_ado_deployments_drop_is_production.sql for the removal.
    status              String,            -- succeeded | failed | partiallySucceeded | canceled | ...
    requested_by        Nullable(String),
    -- The commit/branch the release was built from, when ADO reports it. Lets a
    -- deployment be tied back to a PR later (lead-time-to-production).
    source_branch       Nullable(String),
    source_sha          Nullable(String),
    queued_at           Nullable(DateTime),
    started_at          Nullable(DateTime),
    completed_at        Nullable(DateTime),
    synced_at           DateTime         DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
-- completed_at is Nullable and cannot be partitioned on directly; started_at is
-- always present on a deployment record that has begun.
PARTITION BY toYYYYMM(coalesce(started_at, toDateTime(0)))
ORDER BY (organization_id, org_url, project, kind, deployment_id)
SETTINGS index_granularity = 8192;
