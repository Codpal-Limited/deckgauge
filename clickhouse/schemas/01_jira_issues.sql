-- Raw Jira issues — every type, every project. Filter at promote time.
CREATE TABLE IF NOT EXISTS cockpit.jira_issues
(
    organization_id     String,
    id                  String,
    key                 String,
    project_key         String,
    project_name        String,
    issue_type          String,
    parent_key          Nullable(String),
    epic_key            Nullable(String),
    epic_summary        Nullable(String),
    summary             String,
    description         String           DEFAULT '',
    priority            String           DEFAULT 'None',
    labels              Array(String)    DEFAULT [],
    components          Array(String)    DEFAULT [],
    fix_versions        Array(String)    DEFAULT [],
    assignee            Nullable(String),
    assignee_email      Nullable(String),
    reporter            Nullable(String),
    status              String,
    status_category     String,
    resolution          Nullable(String),
    story_points        Nullable(Float32),
    original_estimate_s Nullable(UInt32),
    time_spent_s        Nullable(UInt32),
    sprint_id           Nullable(String),
    sprint_name         Nullable(String),
    sprint_state        Nullable(String),
    created_at          DateTime,
    updated_at          DateTime,
    resolved_at         Nullable(DateTime),
    due_date            Nullable(Date),
    custom_fields       String           DEFAULT '{}',
    instance_url        String,
    synced_at           DateTime         DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (organization_id, project_key, key)
SETTINGS index_granularity = 8192;
