export type SourceType = 'github' | 'jira' | 'ado' | 'gitlab';

export interface CatalogEntry {
  sourceType: SourceType;
  scopeColumn: string;
}

// Closed-by-default allowlist of ClickHouse tables that the intelligence-query
// SQL console can SELECT from. Each entry maps a table to (a) the source-type
// that scopes it and (b) the column the AST rewriter injects as
// `<scopeColumn> IN (<allowed values>)`.
//
// Verified against the live `cockpit.*` schema (see clickhouse/schemas/) and
// against the references in apps/api/src/widgets/unions.ts + the per-widget
// builders in apps/api/src/intelligence-query/builders/. Materialized views
// (mv_*), state tables, and the developer_identity_map are deliberately
// excluded — they don't carry source-id columns suitable for rewriting and
// aren't referenced by any builder.
export const CATALOG: Readonly<Record<string, CatalogEntry>> = Object.freeze({
  jira_issues:           { sourceType: 'jira',   scopeColumn: 'project_key' },
  jira_transitions:      { sourceType: 'jira',   scopeColumn: 'project_key' },
  github_issues:         { sourceType: 'github', scopeColumn: 'repo_full_name' },
  github_pull_requests:  { sourceType: 'github', scopeColumn: 'repo_full_name' },
  github_commits:        { sourceType: 'github', scopeColumn: 'repo_full_name' },
  github_milestones:     { sourceType: 'github', scopeColumn: 'repo_full_name' },
  github_deployments:    { sourceType: 'github', scopeColumn: 'repo_full_name' },
  ado_work_items:        { sourceType: 'ado',    scopeColumn: 'project' },
  ado_pull_requests:     { sourceType: 'ado',    scopeColumn: 'project' },
  ado_commits:           { sourceType: 'ado',    scopeColumn: 'project' },
  ado_deployments:       { sourceType: 'ado',    scopeColumn: 'project' },
  gitlab_merge_requests: { sourceType: 'gitlab', scopeColumn: 'project_path' },
  gitlab_commits:        { sourceType: 'gitlab', scopeColumn: 'project_path' },
  gitlab_reviews:        { sourceType: 'gitlab', scopeColumn: 'project_path' },
  gitlab_issues:         { sourceType: 'gitlab', scopeColumn: 'project_path' },
});

export function isCatalogedTable(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATALOG, name);
}

export function getCatalogEntry(name: string): CatalogEntry | null {
  const entry = CATALOG[name as keyof typeof CATALOG];
  return entry ?? null;
}

export function listTablesForSourceTypes(sources: ReadonlyArray<SourceType>): string[] {
  const set = new Set(sources);
  return Object.entries(CATALOG)
    .filter(([, entry]) => set.has(entry.sourceType))
    .map(([name]) => name);
}
