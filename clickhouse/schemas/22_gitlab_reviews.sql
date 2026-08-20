-- GitLab MR reviews, derived from approvals + non-system notes on each MR.
CREATE TABLE IF NOT EXISTS cockpit.gitlab_reviews
(
    organization_id     String,
    id                  String,
    project_path        String,
    instance_id         String,
    merge_request_iid   UInt32,
    mr_author_username  String,
    reviewer_username   String,
    reviewer_name       Nullable(String),
    state               String,
    comment_count       UInt16   DEFAULT 0,
    submitted_at        DateTime,
    synced_at           DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(submitted_at)
ORDER BY (organization_id, project_path, merge_request_iid, id)
SETTINGS index_granularity = 8192;
