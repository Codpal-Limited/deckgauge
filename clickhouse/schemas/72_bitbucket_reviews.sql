-- Bitbucket Cloud PR reviews, derived from each PR's /activity feed: approvals
-- and comments, one row per (PR, reviewer). Mirrors 22_gitlab_reviews.sql
-- (project_path → repo_full_name, merge_request_iid → pr_id,
-- mr_author_username → pr_author_username).
--
-- Born tenant-keyed — see 70_bitbucket_pull_requests.sql.
CREATE TABLE IF NOT EXISTS cockpit.bitbucket_reviews
(
    organization_id     String,
    id                  String,
    repo_full_name      String,
    instance_id         String,
    pr_id               UInt32,
    pr_author_username  String,
    reviewer_username   String,            -- Bitbucket `nickname`
    reviewer_uuid       Nullable(String),
    reviewer_name       Nullable(String),
    state               String,            -- APPROVED | COMMENTED | CHANGES_REQUESTED
    comment_count       UInt16   DEFAULT 0,
    submitted_at        DateTime,
    synced_at           DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(submitted_at)
ORDER BY (organization_id, repo_full_name, pr_id, id)
SETTINGS index_granularity = 8192;
