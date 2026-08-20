CREATE TABLE IF NOT EXISTS cockpit.board_item_classification
(
    organization_id String,
    issue_key       String,        -- jira key / "{project}#{ado_id}" / "{repo}#{number}"
    provider        String,        -- jira / ado / github
    classification  String,        -- CAPEX / OPEX
    board_id        String,
    project_id      String,        -- Postgres Project.id (provenance)
    synced_at       DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(synced_at)
ORDER BY (organization_id, provider, issue_key)
SETTINGS index_granularity = 8192;
