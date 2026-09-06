import { chInsertManyWith, type ClickHouseClient } from '../clickhouse.js';
import type { DemoDataset } from './generate.js';

/**
 * Every table the demo WRITES. This function inserts into exactly this list.
 *
 * It is deliberately NOT the removal list: removal has one more table on it.
 * `DEMO_CH_REMOVE_TABLES` below is what `remove.ts` iterates, and it is a
 * superset — a table the seeder populates INDIRECTLY still has to be cleaned
 * up, and it must never be inserted into directly.
 */
export const DEMO_CH_TABLES = [
  'jira_issues',
  'jira_transitions',
  'jira_worklogs',
  'github_pull_requests',
  'github_commits',
  'github_reviews',
  'github_deployments',
] as const;

/**
 * Every table `--remove` must clear: the written tables above, plus the
 * materialized view's target.
 *
 * `cockpit.mv_jira_flow_efficiency` is `TO cockpit.jira_flow_efficiency_state`
 * and fires on every insert into `jira_issues`. The seeder writes resolved
 * issues, so the MV fires on every seed — and `ALTER TABLE jira_issues DELETE`
 * does not touch a materialized view's target table, so removing the demo left
 * aggregate state behind that nothing could ever clean up. Because
 * `jira_flow_efficiency_state` is an `AggregatingMergeTree`, that residue does
 * not merely linger: its `countState`/`avgState` values ADD on every re-seed,
 * so flow efficiency drifts further from the truth each time.
 *
 * It carries `organization_id` and `project_key`, so the jira-branch predicate
 * in `remove.ts` scopes it exactly as it scopes the raw Jira tables.
 *
 * A table added to the generator belongs on BOTH lists; a table the demo only
 * fills through a materialized view belongs on this one alone.
 */
export const DEMO_CH_REMOVE_TABLES = [
  ...DEMO_CH_TABLES,
  'jira_flow_efficiency_state',
] as const;

/**
 * Writes through `chInsertManyWith` rather than `client.insert` deliberately:
 * that is the production tenant-stamp path, including its refusal of an empty
 * organizationId. Three dual-writer suites once wrote `organization_id = ''` by
 * bypassing it, and the rows were unreachable and uncorrectable afterwards —
 * `organization_id` leads every sort key, so ClickHouse has no UPDATE for it.
 */
export async function writeDemoToClickHouse(
  client: ClickHouseClient,
  dataset: DemoDataset,
  organizationId: string,
): Promise<void> {
  const ch = dataset.clickhouse;
  await chInsertManyWith(client, 'cockpit.jira_issues', organizationId, ch.jiraIssues);
  await chInsertManyWith(client, 'cockpit.jira_transitions', organizationId, ch.jiraTransitions);
  await chInsertManyWith(client, 'cockpit.jira_worklogs', organizationId, ch.jiraWorklogs);
  await chInsertManyWith(
    client,
    'cockpit.github_pull_requests',
    organizationId,
    ch.githubPullRequests,
  );
  await chInsertManyWith(client, 'cockpit.github_commits', organizationId, ch.githubCommits);
  await chInsertManyWith(client, 'cockpit.github_reviews', organizationId, ch.githubReviews);
  await chInsertManyWith(
    client,
    'cockpit.github_deployments',
    organizationId,
    ch.githubDeployments,
  );
}
