-- GitHub milestones (replaces github_milestones Postgres table).
CREATE TABLE IF NOT EXISTS cockpit.github_milestones
(
    organization_id     String,
    id                  String,
    repo_full_name      String,
    number              UInt32,
    instance_id         String,
    title               String,
    description         String           DEFAULT '',
    state               String,
    due_on              Nullable(DateTime),
    open_issues         UInt32           DEFAULT 0,
    closed_issues       UInt32           DEFAULT 0,
    created_at          DateTime,
    updated_at          DateTime,
    closed_at           Nullable(DateTime),
    synced_at           DateTime         DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (organization_id, repo_full_name, number)
SETTINGS index_granularity = 8192;
