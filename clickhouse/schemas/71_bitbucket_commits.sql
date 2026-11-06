-- Bitbucket Cloud commits on each repo's main branch.
--
-- Mirrors 21_gitlab_commits.sql (project_path → repo_full_name,
-- merge_request_iid → pr_id). author_name / author_email are parsed from
-- Bitbucket's `author.raw` ("Name <email>"); author_username / author_uuid are
-- filled only when Bitbucket has linked the commit to an account. Bitbucket's
-- commit list carries no line stats, so additions / deletions / changed_files
-- stay at their defaults unless an adapter fetches a diffstat.
--
-- Born tenant-keyed — see 70_bitbucket_pull_requests.sql.
CREATE TABLE IF NOT EXISTS cockpit.bitbucket_commits
(
    organization_id     String,
    id                  String,            -- "{repo_full_name}@{sha}"
    sha                 String,
    repo_full_name      String,
    instance_id         String,
    author_name         String,
    author_email        String,
    author_username     Nullable(String),
    author_uuid         Nullable(String),
    committer_name      String,
    message             String,
    message_subject     String,
    additions           UInt32           DEFAULT 0,
    deletions           UInt32           DEFAULT 0,
    changed_files       UInt16           DEFAULT 0,
    pr_id               Nullable(UInt32),
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
