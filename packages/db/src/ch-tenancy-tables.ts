/**
 * Every ClickHouse table that carries organization data, with the sort key it
 * had before organization_id was prepended.
 *
 * The rebuild script (ch-org-tenancy-migrate.ts) reads `originalOrderBy` to
 * construct the new table, and the row-policy helper reads `table`. Keeping one
 * list means a table cannot be added to the schema and forgotten by isolation.
 */
export interface ChTenantTable {
  readonly table: string;
  readonly originalOrderBy: string;
  /**
   * The table was created after the organization-tenancy migration with
   * organization_id already in place, so no pre-tenancy install ever held it.
   * The fresh-vs-upgraded convergence test excludes these from the legacy
   * fixture check: they cannot exist at its pinned sha, and on an upgraded
   * install they arrive through the ordinary schema-file ledger, not the rebuild.
   */
  readonly bornTenanted?: true;
}

export const CH_TENANT_TABLES: ReadonlyArray<ChTenantTable> = [
  { table: 'jira_issues', originalOrderBy: 'project_key, key' },
  { table: 'jira_transitions', originalOrderBy: 'project_key, issue_key, transitioned_at' },
  { table: 'jira_worklogs', originalOrderBy: 'project_key, issue_key, id' },
  { table: 'github_issues', originalOrderBy: 'repo_full_name, number' },
  { table: 'github_milestones', originalOrderBy: 'repo_full_name, number' },
  { table: 'github_pull_requests', originalOrderBy: 'repo_full_name, number' },
  { table: 'github_commits', originalOrderBy: 'repo_full_name, sha' },
  { table: 'github_reviews', originalOrderBy: 'repo_full_name, pull_request_number, id' },
  { table: 'github_workflow_runs', originalOrderBy: 'repo_full_name, run_id' },
  { table: 'github_deployments', originalOrderBy: 'repo_full_name, deployment_id' },
  { table: 'gitlab_merge_requests', originalOrderBy: 'project_path, iid' },
  { table: 'gitlab_commits', originalOrderBy: 'project_path, sha' },
  { table: 'gitlab_reviews', originalOrderBy: 'project_path, merge_request_iid, id' },
  { table: 'gitlab_issues', originalOrderBy: 'project_path, iid' },
  // Born tenant-keyed (70–73, 2026-11-03): created with organization_id already
  // leading the sort key, so the rebuild script skips them as already migrated.
  // `originalOrderBy` is the key minus that column, for symmetry with the rest.
  { table: 'bitbucket_pull_requests', originalOrderBy: 'repo_full_name, pr_id', bornTenanted: true },
  { table: 'bitbucket_commits', originalOrderBy: 'repo_full_name, sha', bornTenanted: true },
  { table: 'bitbucket_reviews', originalOrderBy: 'repo_full_name, pr_id, id', bornTenanted: true },
  { table: 'bitbucket_deployments', originalOrderBy: 'repo_full_name, deployment_uuid', bornTenanted: true },
  { table: 'ado_work_items', originalOrderBy: 'org_url, project, ado_id' },
  { table: 'ado_transitions', originalOrderBy: 'project, work_item_id, changed_at' },
  { table: 'ado_pull_requests', originalOrderBy: 'org_url, project, pr_id' },
  { table: 'ado_commits', originalOrderBy: 'repo_url, sha' },
  { table: 'ado_reviews', originalOrderBy: 'repo_id, pull_request_id, reviewer_login' },
  { table: 'ado_deployments', originalOrderBy: 'org_url, project, kind, deployment_id' },
  { table: 'developer_identity_map', originalOrderBy: 'provider, login' },
  { table: 'board_item_classification', originalOrderBy: 'provider, issue_key' },
  { table: 'jira_flow_efficiency_state', originalOrderBy: 'project_key, issue_type, week_start' },
] as const;
