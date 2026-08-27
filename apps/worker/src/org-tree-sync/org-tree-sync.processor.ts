import type { PrismaClient } from '@deckgauge/db';
import type { ChScopedReadClientFactory } from '../ch-scoped-read.js';
import {
  buildMatchIndex,
  matchIdentity,
  reduceEmployeeSnapshot,
  emptyHeat,
  mondayOf,
  weekSlotIndex,
  HEAT_WEEKS,
  ACTIVE_WINDOW_DAYS,
  UNMAPPED,
  type MatchIndex,
  type MatchedActivityRow,
  type RankingCounts,
} from '@deckgauge/shared';
import { buildBoardReverseIndex, type BoardReverseIndex } from './board-reverse-index.js';
import {
  fetchActivityIdentities,
  fetchCommitHeat,
  fetchGithubLoginEmails,
  fetchRankingMetrics,
  type ActivityIdentityRow,
  type CommitHeatRow,
  type RankingMetricRow,
} from './org-sync-aggregator.js';

/** A fresh zeroed ranking accumulator. */
function emptyRanking(): RankingCounts {
  return { ticketsClosed: 0, prsMerged: 0, commitsToMain: 0, reviewComments: 0 };
}

export interface RunDeps {
  prisma: PrismaClient;
  /**
   * Every ClickHouse fetcher takes the organization this run resolved, for the
   * SAME reason `buildIndex` does — and it is the same bug, one layer over.
   * `buildBoardReverseIndex` was fixed to take an organization; these three were
   * not, so a per-tree job still aggregated commits, PRs, issues, reviews and
   * assignments from the WHOLE deployment and matched them to this tree's
   * employees by login / email / name.
   *
   * The argument is required rather than something the caller closes over,
   * because a caller that supplies its own tenant can supply a different one from
   * the tree's.
   */
  fetchIdentities: (organizationId: string) => Promise<ActivityIdentityRow[]>;
  /**
   * Builds the board index for ONE organization. The second argument is required
   * and is resolved below from the tree being synced — not passed in by the
   * caller — so the boards an employee can be credited with and the employees
   * themselves cannot come from different tenants.
   */
  buildIndex: (prisma: PrismaClient, organizationId: string) => Promise<BoardReverseIndex>;
  /** Optional weekly commit tallies for the sparkbar; absent → no heat. */
  fetchHeat?: (organizationId: string) => Promise<CommitHeatRow[]>;
  /** Optional per-metric leaderboard tallies; absent → no ranking counts. */
  fetchRanking?: (organizationId: string) => Promise<RankingMetricRow[]>;
  nowIso: string;
}

/**
 * Fold commit-heat rows into a per-employee weekly array (oldest → newest).
 * Rows are matched to employees with the same identity matcher used for
 * activity, and counts land in the slot for their ISO week (out-of-window
 * weeks are dropped). Employees with no in-range commits are absent from the map.
 */
function buildHeatByEmployee(
  rows: CommitHeatRow[],
  matchIndex: MatchIndex,
  nowIso: string,
): Map<string, number[]> {
  const heatByEmployee = new Map<string, number[]>();
  for (const r of rows) {
    if (r.count <= 0) continue;
    const employeeId = matchIdentity(r, matchIndex);
    if (!employeeId) continue;
    const slot = weekSlotIndex(r.weekMonday, nowIso);
    if (slot === null) continue;
    const heat = heatByEmployee.get(employeeId) ?? emptyHeat();
    // `heat[slot]` is `number | undefined` under noUncheckedIndexedAccess even though
    // slot is a validated in-range index; coalesce to keep the compiler satisfied.
    heat[slot] = (heat[slot] ?? 0) + r.count;
    heatByEmployee.set(employeeId, heat);
  }
  return heatByEmployee;
}

/**
 * Fold ranking-metric rows into per-employee raw counts. Rows are matched with the
 * same identity matcher used for activity/heat; unmatched rows and non-positive
 * counts are dropped. Employees with no in-range contribution are absent from the map.
 */
function buildRankingByEmployee(
  rows: RankingMetricRow[],
  matchIndex: MatchIndex,
): Map<string, RankingCounts> {
  const rankingByEmployee = new Map<string, RankingCounts>();
  for (const r of rows) {
    if (r.count <= 0) continue;
    const employeeId = matchIdentity(r, matchIndex);
    if (!employeeId) continue;
    const counts = rankingByEmployee.get(employeeId) ?? emptyRanking();
    counts[r.metric] += r.count;
    rankingByEmployee.set(employeeId, counts);
  }
  return rankingByEmployee;
}

/**
 * Boards an assignment credits.
 *
 * An assignment names an exact work item, so it resolves against the rows actually
 * promoted onto a board rather than the project — several boards routinely slice one
 * Jira/ADO project with different filters, and the project-level index credits all of
 * them. When the item itself is on no board we fall back to its parent: boards commonly
 * track Epics only while engineers are assigned the Stories underneath them, and those
 * engineers are genuinely working the epic the board tracks.
 *
 * The fallback is an alternative, not an addition — the exact row is always the better
 * signal when it resolves. The chain runs row -> parent -> epic because the hierarchy
 * can be two deep: for a Jira sub-task the parent is the Story and the epic is above
 * that, and it is usually the Epic the board tracks.
 */
function resolveAssignmentBoards(
  boardIndex: BoardReverseIndex,
  id: Pick<ActivityIdentityRow, 'kind' | 'rowKey' | 'parentKey' | 'epicKey'>,
): string[] {
  for (const key of [id.rowKey, id.parentKey, id.epicKey]) {
    const hit = boardIndex.lookupRow(id.kind, key);
    if (hit.length > 0) return hit;
  }
  return [];
}

export async function runOrgTreeSync(
  treeId: string,
  deps: RunDeps,
): Promise<{ matched: number; total: number }> {
  const { prisma } = deps;
  // The tenant is resolved HERE, from the tree this run is syncing, because this is
  // the one function that turns a `treeId` into attributed work. Resolving it in
  // `handleOrgTreeSyncJob` instead would leave this function — which is exported and
  // is what every test drives — free to be handed an index built over the whole
  // deployment, which is the bug being closed. `OrgTree` is the tenant key: employees
  // inherit tenancy through it and carry no `organization_id` of their own.
  const { organizationId } = await prisma.orgTree.findUniqueOrThrow({
    where: { id: treeId },
    select: { organizationId: true },
  });
  // Vacancy placeholder nodes are not real people — exclude them from matching
  // so they never inflate the total or appear in the unmatched list.
  const employees = await prisma.orgEmployee.findMany({
    where: { orgTreeId: treeId, isVacancy: false },
    include: { aliases: true },
  });
  const matchIndex = buildMatchIndex(
    employees.map((e) => ({
      id: e.id,
      name: e.name,
      email: e.email,
      aliases: e.aliases.map((a) => ({ provider: a.provider, kind: a.kind, value: a.value })),
    })),
  );
  const [identities, boardIndex, heatRows, rankingRows] = await Promise.all([
    deps.fetchIdentities(organizationId),
    deps.buildIndex(prisma, organizationId),
    deps.fetchHeat ? deps.fetchHeat(organizationId) : Promise.resolve<CommitHeatRow[]>([]),
    deps.fetchRanking
      ? deps.fetchRanking(organizationId)
      : Promise.resolve<RankingMetricRow[]>([]),
  ]);
  const heatByEmployee = buildHeatByEmployee(heatRows, matchIndex, deps.nowIso);
  const rankingByEmployee = buildRankingByEmployee(rankingRows, matchIndex);

  const perEmployee = new Map<string, MatchedActivityRow[]>();
  for (const id of identities) {
    const employeeId = matchIdentity(id, matchIndex);
    if (!employeeId) continue;
    const boards = id.isAssignment
      ? resolveAssignmentBoards(boardIndex, id)
      : // Code activity has no row to key on; the repo/project is the finest scope there is.
        boardIndex.lookup(id.kind, id.scopeKey);
    const row: MatchedActivityRow = {
      employeeId,
      boards: boards.length ? boards : [UNMAPPED],
      isAssignment: id.isAssignment,
      contributedCode: id.contributedCode,
      lastTs: id.lastTs,
      boardNames: boardIndex.boardNames,
    };
    if (!perEmployee.has(employeeId)) perEmployee.set(employeeId, []);
    perEmployee.get(employeeId)!.push(row);
  }

  let matched = 0;
  const unmatched: string[] = [];
  const syncedAt = new Date(deps.nowIso);
  for (const e of employees) {
    const rows = perEmployee.get(e.id) ?? [];
    const snap = reduceEmployeeSnapshot(rows, deps.nowIso);
    if (snap.matched) matched += 1;
    else unmatched.push(e.name);
    await prisma.orgEmployee.update({
      where: { id: e.id },
      data: {
        matched: snap.matched,
        isActive: snap.isActive,
        hasAssignment: snap.hasAssignment,
        lastContributionAt: snap.lastContributionAt ? new Date(snap.lastContributionAt) : null,
        statsJson: {
          ...snap.stats,
          ...(heatByEmployee.has(e.id) ? { heat: heatByEmployee.get(e.id) } : {}),
          ...(rankingByEmployee.has(e.id) ? { ranking: rankingByEmployee.get(e.id) } : {}),
        } as unknown as object,
        syncedAt,
      },
    });
  }
  await prisma.orgTree.update({
    where: { id: treeId },
    data: { lastSyncedAt: syncedAt, lastSyncSummary: { matched, total: employees.length, unmatched } },
  });
  return { matched, total: employees.length };
}

export async function handleOrgTreeSyncJob(
  jobData: { treeId: string },
  prisma: PrismaClient,
  /**
   * The worker's one ClickHouse read factory, injected rather than imported.
   *
   * It used to be `clickhouse` — the INGEST singleton — imported at the top of
   * this file, which is how every read below spanned every tenant. Taking a
   * factory means the client cannot exist before an organization has been named,
   * and it is named inside `runOrgTreeSync` from the tree being synced.
   */
  chFor: ChScopedReadClientFactory,
): Promise<{ matched: number; total: number }> {
  const nowIso = new Date().toISOString();
  const nowMs = new Date(nowIso).getTime();
  // Oldest in-range week's Monday → the sparkbar's left edge.
  const cutoff = mondayOf(new Date(nowMs - (HEAT_WEEKS - 1) * 7 * 86400000))
    .toISOString()
    .slice(0, 10);
  // The leaderboard counts a wider, calendar-day rolling window (not week-bucketed).
  const rankingCutoff = new Date(nowMs - ACTIVE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  // GitHub PR/review rows carry only a login (often tenant-suffixed) and no email;
  // this bridge, learned once from github_commits, lets the email matcher resolve
  // them.
  //
  // It is resolved LAZILY, per organization, because it is a ClickHouse read like
  // any other and cannot be issued before `runOrgTreeSync` has resolved the tree's
  // tenant. Memoised on the promise rather than on the value so the two callers
  // below — which run inside one `Promise.all` — share one query instead of racing
  // to issue two.
  let bridge: Promise<Map<string, string>> | undefined;
  const loginEmailsFor = (organizationId: string): Promise<Map<string, string>> =>
    (bridge ??= fetchGithubLoginEmails(chFor(organizationId)));

  return runOrgTreeSync(jobData.treeId, {
    prisma,
    nowIso,
    fetchIdentities: async (organizationId) =>
      fetchActivityIdentities(chFor(organizationId), await loginEmailsFor(organizationId)),
    buildIndex: buildBoardReverseIndex,
    fetchHeat: (organizationId) => fetchCommitHeat(chFor(organizationId), cutoff),
    fetchRanking: async (organizationId) =>
      fetchRankingMetrics(
        chFor(organizationId),
        rankingCutoff,
        await loginEmailsFor(organizationId),
      ),
  });
}
