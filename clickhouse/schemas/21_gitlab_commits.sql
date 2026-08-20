-- GitLab commits — author and committer per commit.
CREATE TABLE IF NOT EXISTS cockpit.gitlab_commits
(
    organization_id     String,
    id                  String,
    sha                 String,
    project_path        String,
    instance_id         String,
    author_name         String,
    author_email        String,
    committer_name      String,
    message             String,
    message_subject     String,
    additions           UInt32           DEFAULT 0,
    deletions           UInt32           DEFAULT 0,
    changed_files       UInt16           DEFAULT 0,
    merge_request_iid   Nullable(UInt32),
    is_merge_commit     UInt8            DEFAULT 0,
    committed_at        DateTime,
    ai_assisted         UInt8            DEFAULT 0,
    ai_confidence       Nullable(Float32),
    ai_signals          String           DEFAULT '{}',
    linked_ticket_keys  Array(String)    DEFAULT [],
    synced_at           DateTime         DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(committed_at)
ORDER BY (organization_id, project_path, sha)
SETTINGS index_granularity = 8192;
