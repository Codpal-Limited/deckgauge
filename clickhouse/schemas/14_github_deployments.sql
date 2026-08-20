-- clickhouse/schemas/14_github_deployments.sql
CREATE TABLE IF NOT EXISTS cockpit.github_deployments
(
    organization_id   String,
    id                String,             -- "{owner}/{repo}#{deployment_id}"
    org               String,
    repo_full_name    String,
    instance_id       String,             -- disambiguates multi-instance ingestion (matches siblings 09/10/11/13)
    deployment_id     UInt64,
    ref               String,
    sha               String,
    task              String,             -- usually "deploy"
    environment       String,
    production        UInt8,              -- 0/1 mirror of GH `production_environment`
    creator_login     String,
    created_at        DateTime,
    updated_at        DateTime,
    latest_status     Nullable(String),   -- success / failure / in_progress / queued / ...
    latest_status_at  Nullable(DateTime),
    _ingested_at      DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (organization_id, repo_full_name, deployment_id)
SETTINGS index_granularity = 8192;
