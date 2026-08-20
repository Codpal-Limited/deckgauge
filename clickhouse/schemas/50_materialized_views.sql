-- ============================================================================
-- Materialized views — incremental aggregates updated as raw tables fill.
-- All state tables use AggregatingMergeTree; queries finalize with countMerge,
-- sumMerge, quantileMerge, etc.
-- ============================================================================

-- ── Jira flow efficiency (cycle time by issue type) ──────────────────────────
CREATE TABLE IF NOT EXISTS cockpit.jira_flow_efficiency_state
(
    organization_id String,
    project_key     String,
    issue_type      String,
    week_start      Date,
    issues_closed   AggregateFunction(count),
    avg_cycle_days  AggregateFunction(avg, Float32),
    p50_cycle_days  AggregateFunction(quantile(0.5), Float32),
    p90_cycle_days  AggregateFunction(quantile(0.9), Float32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(week_start)
ORDER BY (organization_id, project_key, issue_type, week_start);

CREATE MATERIALIZED VIEW IF NOT EXISTS cockpit.mv_jira_flow_efficiency
TO cockpit.jira_flow_efficiency_state AS
SELECT
    -- Must stay named exactly `organization_id` (no alias): a TO-target MV
    -- matches its SELECT output to the destination table BY COLUMN NAME, not
    -- position. Renaming this breaks the write silently — the destination's
    -- organization_id column falls back to its type default ('') instead of
    -- erroring, and every organization's rows collapse into one blended
    -- group. (Also note: this same pass-through is why the MV itself gets an
    -- `organization_id` entry in system.columns — see ch-tenancy-schema.test.ts.)
    organization_id,
    project_key,
    issue_type,
    toMonday(assumeNotNull(resolved_at))                                                     AS week_start,
    countState()                                                                             AS issues_closed,
    avgState(toFloat32(dateDiff('day', created_at, assumeNotNull(resolved_at))))              AS avg_cycle_days,
    quantileState(0.5)(toFloat32(dateDiff('day', created_at, assumeNotNull(resolved_at))))    AS p50_cycle_days,
    quantileState(0.9)(toFloat32(dateDiff('day', created_at, assumeNotNull(resolved_at))))    AS p90_cycle_days
FROM cockpit.jira_issues
-- WHERE filter guarantees resolved_at is non-null; assumeNotNull above strips
-- the Nullable wrapper so avg_cycle_days writes Float32 (matching the state
-- table) rather than Nullable(Float32), which ClickHouse rejects with
-- Code 70 CANNOT_CONVERT_TYPE.
WHERE resolved_at IS NOT NULL AND status_category = 'Done'
GROUP BY organization_id, project_key, issue_type, week_start;
