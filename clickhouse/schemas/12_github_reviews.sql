-- GitHub PR reviews (approved / changes_requested / commented / dismissed).
CREATE TABLE IF NOT EXISTS cockpit.github_reviews
(
    organization_id     String,
    id                  String,
    repo_full_name      String,
    pull_request_number UInt32,
    pr_author_login     String,
    reviewer_login      String,
    reviewer_name       Nullable(String),
    state               String,
    body                String    DEFAULT '',
    comment_count       UInt16    DEFAULT 0,
    submitted_at        DateTime,
    synced_at           DateTime  DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(submitted_at)
ORDER BY (organization_id, repo_full_name, pull_request_number, id)
SETTINGS index_granularity = 8192;
