import type { PrismaClient } from '../generated/prisma/client.js';
import type { ClickHouseClient } from '../clickhouse.js';
import { DEMO_CH_REMOVE_TABLES } from './write-clickhouse.js';
import {
  DEMO_JIRA_INSTANCE_ID,
  DEMO_GITHUB_INSTANCE_ID,
  DEMO_ROADMAP_ID,
  DEMO_COMPARISON_ID,
  DEMO_ORG_TREE_ID,
  DEMO_FOLDER_ID,
  demoTimesheetRuleId,
} from './write-postgres.js';
import type { DemoDataset } from './generate.js';

/**
 * What a removal actually deleted, so the CLI can report it instead of
 * asserting it. `--remove` used to print "Demo data removed. Nothing else was
 * touched." whether it had deleted two boards or nothing at all, which is the
 * one moment an installer most needs to be told the truth.
 *
 * The Postgres numbers count ROOTS, not rows: each board carries its groups,
 * projects, statuses, owners, columns, views and board-source rows down with
 * it through `onDelete: Cascade`, and those are not counted here because
 * Prisma's `deleteMany` does not report them.
 */
export interface DemoRemovalCounts {
  boards: number;
  roadmaps: number;
  comparisons: number;
  orgTrees: number;
  timesheetRules: number;
  boardFolders: number;
  jiraInstances: number;
  gitHubInstances: number;
  /** Rows counted in ClickHouse immediately before the delete that removed them. */
  clickhouseRows: number;
}

/** True when a removal matched nothing at all in either store. */
export function removedNothing(counts: DemoRemovalCounts): boolean {
  return Object.values(counts).every((n) => n === 0);
}

/**
 * Deletes by ID, never by name.
 *
 * The id set is re-derived from the same generator (and, for the singleton
 * roots, imported from `write-postgres.ts` rather than re-spelled here — a
 * `demoId()` key that differs by one character is a row that can never be
 * removed), so an installer who renamed a demo board can still remove it —
 * and somebody else's board that happens to be called "Demo — Mobile Squad"
 * survives.
 *
 * Cascades verified against `packages/db/prisma/schema.prisma` (Board, Roadmap,
 * Comparison and OrgTree all cascade to their own children — groups, projects,
 * statuses, owners, columns, views, widgets, access entries, board sources,
 * employees, org-tree access, the org-tree timesheet config — via the models'
 * own `onDelete: Cascade` foreign keys). One deliberate exception:
 * `TimesheetStatusRule.organizationId` is the ONLY cascade path on that model
 * (`organization Organization @relation(..., onDelete: Cascade)`) — it has no
 * relation to `OrgTree` at all, so deleting the org tree above does not touch
 * these rows. They are deleted explicitly, scoped by both id and
 * organizationId, the same tenant discipline every other delete here uses.
 */
export async function removeDemoFromPostgres(
  prisma: PrismaClient,
  dataset: DemoDataset,
  organizationId: string,
): Promise<Omit<DemoRemovalCounts, 'clickhouseRows'>> {
  const boardIds = dataset.boards.map((b) => b.id);
  const timesheetRuleIds = dataset.employees.map((e) => demoTimesheetRuleId(e.key));

  return prisma.$transaction(async (tx) => {
    // Roots only. Board cascades to groups, projects, statuses, owners,
    // columns, views, widgets, access entries and both board-source tables;
    // OrgTree cascades to employees, access and the timesheet config; Roadmap
    // and Comparison cascade to their own children.
    const boards = await tx.board.deleteMany({ where: { id: { in: boardIds }, organizationId } });
    const roadmaps = await tx.roadmap.deleteMany({
      where: { id: DEMO_ROADMAP_ID, organizationId },
    });
    const comparisons = await tx.comparison.deleteMany({
      where: { id: DEMO_COMPARISON_ID, organizationId },
    });
    const orgTrees = await tx.orgTree.deleteMany({
      where: { id: DEMO_ORG_TREE_ID, organizationId },
    });

    // TimesheetStatusRule cascades from Organization, NOT from OrgTree — see
    // the docblock above. Deleting the four roots plus the two instances below
    // would not remove these; they must be listed explicitly.
    const timesheetRules = await tx.timesheetStatusRule.deleteMany({
      where: { id: { in: timesheetRuleIds }, organizationId },
    });

    const boardFolders = await tx.boardFolder.deleteMany({
      where: { id: DEMO_FOLDER_ID, organizationId },
    });

    // The instances last: their project/repo syncs cascade from them
    // (JiraProjectSync.jiraInstanceId and GitHubRepoSync.githubInstanceId are
    // both `onDelete: Cascade`), and both carry `ownerUserId: null`, so the
    // `onDelete: Restrict` on that relation is never engaged.
    const jiraInstances = await tx.jiraInstance.deleteMany({
      where: { id: DEMO_JIRA_INSTANCE_ID, organizationId },
    });
    const gitHubInstances = await tx.gitHubInstance.deleteMany({
      where: { id: DEMO_GITHUB_INSTANCE_ID, organizationId },
    });

    return {
      boards: boards.count,
      roadmaps: roadmaps.count,
      comparisons: comparisons.count,
      orgTrees: orgTrees.count,
      timesheetRules: timesheetRules.count,
      boardFolders: boardFolders.count,
      jiraInstances: jiraInstances.count,
      gitHubInstances: gitHubInstances.count,
    };
  }, { timeout: 120_000 });
}

/**
 * ClickHouse has no id set to delete against cheaply, so removal is by tenant
 * plus the catalog's static source keys — both fixed, not derived from the
 * run's clock, so a re-seed and a later removal always agree on them.
 *
 * `ALTER TABLE … DELETE` (a lightweight *mutation*, as opposed to `DROP` /
 * `TRUNCATE`) — CLAUDE.md § Testing is explicit that nothing on this path
 * drops a database, and these tables are shared with the installer's real
 * synced data.
 *
 * `SETTINGS mutations_sync = 2` is not optional here. By default `ALTER
 * TABLE … DELETE` queues the mutation and returns immediately, and the rows
 * remain visible to a `FINAL` read (what the UI and this function's own test
 * use) until the background mutation finishes on every replica — observed
 * directly while writing the removal suite: without this setting, a `FINAL`
 * count taken right after `removeDemoFromClickHouse` resolves still saw most
 * of the just-seeded rows. `mutations_sync = 2` makes the query wait for the
 * mutation to apply on this replica and every other one before returning, so
 * by the time `--remove` reports done, the rows are actually gone.
 */
export async function removeDemoFromClickHouse(
  client: ClickHouseClient,
  dataset: DemoDataset,
  organizationId: string,
): Promise<number> {
  const projectKeys = dataset.boards.map((b) => b.jiraProjectKey);
  const repos = dataset.boards.map((b) => b.repoFullName);
  let removed = 0;

  for (const table of DEMO_CH_REMOVE_TABLES) {
    const isJira = table.startsWith('jira_');
    const predicate =
      'organization_id = {org:String} AND ' +
      (isJira
        ? 'project_key IN ({keys:Array(String)})'
        : 'repo_full_name IN ({repos:Array(String)})');
    const query_params = { org: organizationId, keys: projectKeys, repos };

    // Counted BEFORE the delete, and with FINAL, so `--remove` can report what
    // it actually removed rather than asserting that it did. `ALTER TABLE …
    // DELETE` is a mutation and reports no affected-row count of its own.
    const counted = await client.query({
      query: `SELECT count() AS n FROM cockpit.${table} FINAL WHERE ${predicate}`,
      query_params,
      format: 'JSONEachRow',
    });
    const [row] = await counted.json<{ n: string }>();
    removed += Number(row?.n ?? 0);

    await client.command({
      query:
        `ALTER TABLE cockpit.${table} DELETE WHERE ${predicate} SETTINGS mutations_sync = 2`,
      query_params,
    });
  }

  return removed;
}
