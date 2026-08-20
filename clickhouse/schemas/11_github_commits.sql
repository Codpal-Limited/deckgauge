-- GitHub commits — including author (git identity) and committer (often the merge bot).
CREATE TABLE IF NOT EXISTS cockpit.github_commits
(
    organization_id     String,
    id                  String,
    sha                 String,
    repo_full_name      String,
    instance_id         String,
    author_login        Nullable(String),
    author_name         String,
    author_email        String,
    committer_login     Nullable(String),
    committer_name      String,
    message             String,
    message_subject     String,
    additions           UInt32           DEFAULT 0,
    deletions           UInt32           DEFAULT 0,
    changed_files       UInt16           DEFAULT 0,
    branch              Nullable(String),
    pull_request_number Nullable(UInt32),
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
ORDER BY (organization_id, repo_full_name, sha)
SETTINGS index_granularity = 8192;
