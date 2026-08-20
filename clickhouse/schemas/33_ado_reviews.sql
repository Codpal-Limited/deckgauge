-- Azure DevOps PR reviews — one row per reviewer vote.
--   vote =  10 → approved
--   vote =   5 → approved-with-suggestions
--   vote =   0 → no-vote
--   vote =  -5 → waiting-for-author
--   vote = -10 → rejected
CREATE TABLE IF NOT EXISTS cockpit.ado_reviews
(
    organization_id     String,
    id                  String,
    org_url             String,
    project             String,
    repo_id             String,
    repo_name           String,
    pull_request_id     UInt32,
    pr_author_login     String,
    reviewer_login      String,
    reviewer_name       Nullable(String),
    vote                Int8,
    state               String,
    body                String           DEFAULT '',
    comment_count       UInt16           DEFAULT 0,
    submitted_at        DateTime,
    instance_id         String,
    synced_at           DateTime         DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(submitted_at)
ORDER BY (organization_id, repo_id, pull_request_id, reviewer_login)
SETTINGS index_granularity = 8192;
