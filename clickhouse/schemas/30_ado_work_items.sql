-- Azure DevOps work items (Epic, Feature, User Story, Task, Bug, ...).
CREATE TABLE IF NOT EXISTS cockpit.ado_work_items
(
    organization_id     String,
    id                  String,
    ado_id              UInt32,
    org_url             String,
    project             String,
    area_path           String           DEFAULT '',
    iteration_path      String           DEFAULT '',
    work_item_type      String,
    title               String,
    description         String           DEFAULT '',
    state               String,
    reason              Nullable(String),
    priority            Nullable(UInt8),
    assigned_to         Nullable(String),
    assigned_to_email   Nullable(String),
    created_by          Nullable(String),
    changed_by          Nullable(String),
    parent_ado_id       Nullable(UInt32),
    story_points        Nullable(Float32),
    remaining_work      Nullable(Float32),
    completed_work      Nullable(Float32),
    tags                Array(String)    DEFAULT [],
    sprint_name         Nullable(String),
    sprint_path         Nullable(String),
    custom_fields       String           DEFAULT '{}',
    created_at          DateTime,
    updated_at          DateTime,
    closed_at           Nullable(DateTime),
    instance_id         String,
    synced_at           DateTime         DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (organization_id, org_url, project, ado_id)
SETTINGS index_granularity = 8192;
