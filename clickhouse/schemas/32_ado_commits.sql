-- Azure DevOps commits — all branches, deduped by (repo_url, sha).
-- ReplacingMergeTree on synced_at means the most-recently-synced row wins
-- when the same SHA is observed across multiple branches in the same repo.
-- The `branch` column stores the first branch the commit was seen on per
-- sync run; downstream analytics treat (repo_url, sha) as the identity.
CREATE TABLE IF NOT EXISTS cockpit.ado_commits
(
    organization_id     String,
    id                  String,
    sha                 String,
    org_url             String,
    project             String,
    repo_id             String,
    repo_name           String,
    repo_url            String,
    instance_id         String,
    author_login        Nullable(String),
    author_name         String,
    author_email        String,
    committer_name      String,
    committer_email     String,
    message             String,
    message_subject     String,
    additions           UInt32           DEFAULT 0,
    deletions           UInt32           DEFAULT 0,
    changed_files       UInt16           DEFAULT 0,
    branch              Nullable(String),
    pull_request_id     Nullable(UInt32),
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
ORDER BY (organization_id, repo_url, sha)
SETTINGS index_granularity = 8192;
