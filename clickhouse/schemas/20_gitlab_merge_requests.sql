-- GitLab merge requests.
CREATE TABLE IF NOT EXISTS cockpit.gitlab_merge_requests
(
    organization_id     String,
    id                  String,
    project_path        String,
    iid                 UInt32,
    instance_id         String,
    title               String,
    description         String           DEFAULT '',
    state               String,
    is_draft            UInt8            DEFAULT 0,
    source_branch       String,
    target_branch       String,
    labels              Array(String)    DEFAULT [],
    milestone_title     Nullable(String),
    author_username     String,
    author_name         Nullable(String),
    assignee_username   Nullable(String),
    reviewers           Array(String)    DEFAULT [],
    additions           UInt32           DEFAULT 0,
    deletions           UInt32           DEFAULT 0,
    changed_files       UInt16           DEFAULT 0,
    created_at          DateTime,
    updated_at          DateTime,
    merged_at           Nullable(DateTime),
    closed_at           Nullable(DateTime),
    first_review_at     Nullable(DateTime),
    first_approval_at   Nullable(DateTime),
    cycle_time_hours    Nullable(Float32),
    review_time_hours   Nullable(Float32),
    ai_assisted         UInt8            DEFAULT 0,
    ai_confidence       Nullable(Float32),
    ai_signals          String           DEFAULT '{}',
    linked_ticket_keys  Array(String)    DEFAULT [],
    merged_by_username  Nullable(String),
    merge_commit_sha    Nullable(String),
    synced_at           DateTime         DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (organization_id, project_path, iid)
SETTINGS index_granularity = 8192;
