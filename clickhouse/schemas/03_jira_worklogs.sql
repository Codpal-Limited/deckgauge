-- Jira worklog entries — time tracking per user per issue.
CREATE TABLE IF NOT EXISTS cockpit.jira_worklogs
(
    organization_id String,
    id              String,
    issue_key       String,
    project_key     String,
    author          String,
    author_email    Nullable(String),
    time_spent_s    UInt32,
    started_at      DateTime,
    created_at      DateTime,
    synced_at       DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(started_at)
ORDER BY (organization_id, project_key, issue_key, id)
SETTINGS index_granularity = 8192;
