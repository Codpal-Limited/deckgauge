-- GitHub pull requests (all states — open, merged, closed, draft).
CREATE TABLE IF NOT EXISTS cockpit.github_pull_requests
(
    organization_id     String,
    id                  String,
    repo_full_name      String,
    number              UInt32,
    instance_id         String,
    title               String,
    body                String           DEFAULT '',
    state               String,
    is_draft            UInt8            DEFAULT 0,
    base_branch         String,
    head_branch         String,
    labels              Array(String)    DEFAULT [],
    milestone_title     Nullable(String),
    author_login        String,
    author_name         Nullable(String),
    requested_reviewers Array(String)    DEFAULT [],
    additions           UInt32           DEFAULT 0,
    deletions           UInt32           DEFAULT 0,
    changed_files       UInt16           DEFAULT 0,
    commit_count        UInt16           DEFAULT 0,
    created_at          DateTime,
    updated_at          DateTime,
    merged_at           Nullable(DateTime),
    closed_at           Nullable(DateTime),
    first_review_at     Nullable(DateTime),
    first_approval_at   Nullable(DateTime),
    cycle_time_hours    Nullable(Float32),
    review_time_hours   Nullable(Float32),
    approval_time_hours Nullable(Float32),
    merge_time_hours    Nullable(Float32),
    ai_assisted         UInt8            DEFAULT 0,
    ai_confidence       Nullable(Float32),
    ai_signals          String           DEFAULT '{}',
    linked_ticket_keys  Array(String)    DEFAULT [],
    merge_commit_sha    Nullable(String),
    merged_by_login     Nullable(String),
    synced_at           DateTime         DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (organization_id, repo_full_name, number)
SETTINGS index_granularity = 8192;
