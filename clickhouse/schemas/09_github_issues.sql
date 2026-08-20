-- GitHub issues (replaces github_issues Postgres table).
CREATE TABLE IF NOT EXISTS cockpit.github_issues
(
    organization_id     String,
    id                  String,
    repo_full_name      String,
    number              UInt32,
    instance_id         String,
    title               String,
    body                String           DEFAULT '',
    state               String,
    labels              Array(String)    DEFAULT [],
    assignee_login      Nullable(String),
    assignee_name       Nullable(String),
    milestone_number    Nullable(UInt32),
    milestone_title     Nullable(String),
    linked_ticket_keys  Array(String)    DEFAULT [],
    is_pull_request     UInt8            DEFAULT 0,
    pull_request_number Nullable(UInt32),
    created_at          DateTime,
    updated_at          DateTime,
    closed_at           Nullable(DateTime),
    synced_at           DateTime         DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (organization_id, repo_full_name, number)
SETTINGS index_granularity = 8192;
