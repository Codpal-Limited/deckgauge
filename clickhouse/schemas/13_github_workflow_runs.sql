-- clickhouse/schemas/13_github_workflow_runs.sql
CREATE TABLE IF NOT EXISTS cockpit.github_workflow_runs
(
    organization_id     String,
    id                  String,            -- "{owner}/{repo}#{run_id}"
    org                 String,
    repo_full_name      String,
    instance_id         String,            -- disambiguates multi-instance ingestion (matches siblings 09/10/11)
    run_id              UInt64,
    workflow_id         UInt64,
    workflow_name       String,
    head_branch         String,
    head_sha            String,
    event               String,            -- push, pull_request, schedule, ...
    status              String,            -- queued, in_progress, completed
    conclusion          String,            -- success, failure, cancelled, skipped, ''
    run_attempt         UInt16,
    actor_login         String,
    created_at          DateTime,
    started_at          Nullable(DateTime),
    updated_at          DateTime,
    duration_ms         Nullable(UInt64),
    _ingested_at        DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(_ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (organization_id, repo_full_name, run_id)
SETTINGS index_granularity = 8192;
