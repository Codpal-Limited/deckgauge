-- Full Jira status-transition changelog.
CREATE TABLE IF NOT EXISTS cockpit.jira_transitions
(
    organization_id     String,
    id                  String,
    issue_key           String,
    project_key         String,
    issue_type          String,
    assignee            Nullable(String),
    from_status         String,
    from_category       String,
    to_status           String,
    to_category         String,
    transitioned_by     Nullable(String),
    transitioned_at     DateTime,
    time_in_prev_status_s UInt32         DEFAULT 0,
    synced_at           DateTime         DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(transitioned_at)
ORDER BY (organization_id, project_key, issue_key, transitioned_at)
SETTINGS index_granularity = 8192;
