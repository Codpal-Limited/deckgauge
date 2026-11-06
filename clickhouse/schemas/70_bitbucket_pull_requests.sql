-- Bitbucket Cloud pull requests.
--
-- Mirrors 20_gitlab_merge_requests.sql column for column wherever Bitbucket has
-- the concept, renamed to Bitbucket's vocabulary (project_path → repo_full_name
-- "{workspace}/{repo_slug}", iid → pr_id), so a union leg stays mechanical.
-- GitLab's labels / milestone_title / assignee_username are deliberately absent:
-- Bitbucket PRs have none of the three.
--
-- Born tenant-keyed: organization_id is the first sort column from creation, so
-- ch-org-tenancy-migrate.ts finds it "already tenant-keyed" and never rebuilds it.
CREATE TABLE IF NOT EXISTS cockpit.bitbucket_pull_requests
(
    organization_id     String,
    id                  String,            -- "{repo_full_name}#{pr_id}"
    repo_full_name      String,
    pr_id               UInt32,
    workspace           String,
    instance_id         String,
    title               String,
    description         String           DEFAULT '',
    state               String,            -- OPEN | MERGED | DECLINED | SUPERSEDED
    is_draft            UInt8            DEFAULT 0,
    -- 1 when the SOURCE branch is itself long-lived (stage, staging, develop,
    -- dev, main, master, prod, production, release*): a stage→prod release PR.
    -- Stored, but excluded from the PR/review unions so a feature is not counted
    -- twice (once into stage, again via the release). hotfix/*→prod is 0.
    is_release          UInt8            DEFAULT 0,
    source_branch       String,
    target_branch       String,
    author_username     String,            -- Bitbucket `nickname`
    author_uuid         Nullable(String),  -- account `{uuid}`, stable for joins
    author_name         Nullable(String),  -- display name
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
ORDER BY (organization_id, repo_full_name, pr_id)
SETTINGS index_granularity = 8192;
