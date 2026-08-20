/**
 * Removing a deleted Jira issue's analytics rows.
 *
 * Once the sync has CONFIRMED an issue no longer resolves in Jira, its rows in
 * ClickHouse are the only remaining reason it still contributes timesheet hours
 * and widget numbers — every read filters by project key, not by which issues
 * still exist, so no query-side change could exclude it without touching each of
 * the ~10 separate Jira legs (a missed leg being a silent partial exclusion).
 * Deleting the rows excludes it everywhere at once.
 *
 * This is not reversible. `Project.jiraDeletedAt` is the record of what was
 * purged and when.
 *
 * `board_item_classification` is deliberately NOT purged: its rows are mirrored
 * from the surviving Postgres Project row, so the mirror would simply write them
 * back. With the transitions gone the classification has no spans to classify.
 */

/** The tables that carry per-issue Jira history, and the column holding the key. */
const PURGE_TARGETS = [
  { table: 'jira_issues', keyColumn: 'key' },
  { table: 'jira_transitions', keyColumn: 'issue_key' },
  { table: 'jira_worklogs', keyColumn: 'issue_key' },
] as const;

export interface JiraPurgeStatement {
  table: string;
  query: string;
  params: { org: string; keys: string[] };
}

/** Runs a parameterised statement. Matches @clickhouse/client's `command`. */
export interface ChCommandClient {
  command(params: { query: string; query_params?: Record<string, unknown> }): Promise<unknown>;
}

/**
 * One DELETE per table, each bound to a single organization. Returns nothing
 * when there is no work or no organization to scope to — an unscoped delete
 * would reach across tenants.
 */
export function buildJiraPurgeStatements(
  organizationId: string,
  issueKeys: readonly string[],
): JiraPurgeStatement[] {
  if (!organizationId) return [];
  const keys = [...new Set(issueKeys)];
  if (keys.length === 0) return [];

  return PURGE_TARGETS.map(({ table, keyColumn }) => ({
    table,
    query:
      `DELETE FROM cockpit.${table} ` +
      `WHERE organization_id = {org:String} AND ${keyColumn} IN {keys:Array(String)}`,
    params: { org: organizationId, keys },
  }));
}

/** Execute the purge. Throws on the first failure; the caller decides what that costs. */
export async function purgeJiraIssueKeys(
  client: ChCommandClient,
  organizationId: string,
  issueKeys: readonly string[],
): Promise<void> {
  for (const statement of buildJiraPurgeStatements(organizationId, issueKeys)) {
    await client.command({ query: statement.query, query_params: statement.params });
  }
}
