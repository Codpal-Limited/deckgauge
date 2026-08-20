-- ADO work item state transitions (the changelog).
CREATE TABLE IF NOT EXISTS cockpit.ado_transitions
(
    organization_id     String,
    id                  String,
    work_item_id        UInt32,
    project             String,
    work_item_type      String,
    assigned_to         Nullable(String),
    from_state          String,
    to_state            String,
    changed_by          Nullable(String),
    changed_at          DateTime,
    time_in_prev_state_s UInt32          DEFAULT 0,
    synced_at           DateTime         DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
PARTITION BY toYYYYMM(changed_at)
ORDER BY (organization_id, project, work_item_id, changed_at)
SETTINGS index_granularity = 8192;
