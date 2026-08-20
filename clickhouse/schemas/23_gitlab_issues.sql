-- GitLab issues (parity with github_issues; scoped by project_path).
CREATE TABLE IF NOT EXISTS cockpit.gitlab_issues
(
    organization_id     String,
    id                  String,
    project_path        String,
    iid                 UInt32,
    instance_id         String,
    title               String,
    state               String,
    labels              Array(String)    DEFAULT [],
    assignee_username   Nullable(String),
    assignee_name       Nullable(String),
    milestone_title     Nullable(String),
    linked_ticket_keys  Array(String)    DEFAULT [],
    created_at          DateTime,
    updated_at          DateTime,
    closed_at           Nullable(DateTime),
    synced_at           DateTime         DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (organization_id, project_path, iid)
SETTINGS index_granularity = 8192;
