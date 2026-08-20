-- Azure DevOps Repos pull requests.
CREATE TABLE IF NOT EXISTS cockpit.ado_pull_requests
(
    organization_id     String,
    id                  String,
    pr_id               UInt32,
    org_url             String,
    project             String,
    repo_name           String,
    title               String,
    description         String           DEFAULT '',
    status              String,
    is_draft            UInt8            DEFAULT 0,
    source_branch       String,
    target_branch       String,
    labels              Array(String)    DEFAULT [],
    created_by_login    String,
    created_by_name     Nullable(String),
    reviewers           Array(String)    DEFAULT [],
    additions           UInt32           DEFAULT 0,
    deletions           UInt32           DEFAULT 0,
    created_at          DateTime,
    updated_at          DateTime,
    closed_at           Nullable(DateTime),
    first_vote_at       Nullable(DateTime),
    cycle_time_hours    Nullable(Float32),
    review_time_hours   Nullable(Float32),
    ai_assisted         UInt8            DEFAULT 0,
    ai_confidence       Nullable(Float32),
    ai_signals          String           DEFAULT '{}',
    linked_ticket_keys  Array(String)    DEFAULT [],
    instance_id         String,
    synced_at           DateTime         DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (organization_id, org_url, project, pr_id)
SETTINGS index_granularity = 8192;
