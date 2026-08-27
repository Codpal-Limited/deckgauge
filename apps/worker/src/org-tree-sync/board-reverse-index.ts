import type { PrismaClient } from '@deckgauge/db';
// githubRowKey is not used here: GitHub ids arrive already in "owner/repo#number"
// form on Project.githubIssueId, built by github-sync.processor.ts through that same
// builder. Jira and ADO keys are assembled here instead.
import { jiraRowKey, adoRowKey } from './row-keys.js';

export interface BoardReverseIndex {
  /**
   * Boards that source a whole repo / project. Correct for code signals (a commit
   * or PR belongs to a repo, not to a board row) but deliberately coarse: several
   * boards can slice one Jira/ADO project, and this cannot tell those slices apart.
   */
  lookup(kind: 'gh' | 'ado' | 'jira', key: string): string[];
  /**
   * Boards that actually hold a given work-item row. Use for assignment signals,
   * where the exact ticket is known — this respects each board's JQL and
   * issue-type filter because it reads the rows already promoted onto the board.
   */
  lookupRow(kind: 'gh' | 'ado' | 'jira', rowKey: string | null): string[];
  boardNames: Record<string, string>;
}

/**
 * Build the index for ONE organization.
 *
 * `organizationId` is required, not optional. Every key this index is looked up by
 * — `owner/repo`, a Jira project key, an ADO project name, a work-item row key — is
 * unique per HOST, never per Deckgauge deployment, so a deployment-wide index
 * consumed by the per-tree org sync attributed other tenants' boards to this
 * tenant's employees and wrote their ids and names into `OrgEmployee.statsJson`.
 * An optional parameter is how that returns: the one caller that forgets it gets
 * the old behaviour silently. Same reason `GitHubPromoteOptions.instanceId` and
 * `PageStateDeps.organizationId` are required (TENANCY-PROGRAMME §5a).
 *
 * Only `Board` carries `organization_id`; `BoardGitHubSource`, `BoardAdoSource`,
 * `BoardJiraSource` and `Project` inherit tenancy through their board, so those
 * four scope through the `board` relation rather than a column of their own.
 */
export async function buildBoardReverseIndex(
  prisma: PrismaClient,
  organizationId: string,
): Promise<BoardReverseIndex> {
  // A blank id is not a wildcard here — Prisma would match no rows and hand back a
  // silently empty index, which reads as "nobody is on any board" rather than as a
  // misconfigured caller.
  if (!organizationId) {
    throw new Error('buildBoardReverseIndex requires an organizationId');
  }
  // The board relation hop, spelled once.
  const inOrg = { board: { organizationId } };
  // On the `project` read below this predicate is DEFENCE IN DEPTH, and that was
  // established by mutation rather than assumed: removing it leaves the suite green,
  // because the row index only ever credits a board that `intelBoards` already
  // admits, and `intelBoards` is built from the three source reads above — which
  // ARE scoped. It stays for two reasons. It keeps the boundary from resting on a
  // downstream gate three screens away (the shape §5b keeps finding: "holds by luck
  // of the call site"), and without it every org-tree sync drags every other
  // tenant's promoted rows through worker memory. See the note in
  // `board-reverse-index-tenancy.test.ts`.
  const [boards, gh, ado, jira, rows] = await Promise.all([
    prisma.board.findMany({ where: { organizationId }, select: { id: true, name: true } }),
    prisma.boardGitHubSource.findMany({
      where: { useForIntelligence: true, ...inOrg },
      include: { gitHubRepoSync: true },
    }),
    prisma.boardAdoSource.findMany({
      where: { useForIntelligence: true, ...inOrg },
      include: { azureDevOpsProjectSync: true },
    }),
    prisma.boardJiraSource.findMany({ where: { ...inOrg }, include: { jiraProjectSync: true } }),
    prisma.project.findMany({
      where: {
        boardId: { not: null },
        ...inOrg,
        OR: [
          { jiraKey: { not: null }, jiraRemovedFromSource: false },
          { adoWorkItemId: { not: null }, adoRemovedFromSource: false },
          { githubIssueId: { not: null }, githubRemovedFromSource: false },
        ],
      },
      select: {
        boardId: true,
        jiraKey: true,
        jiraRemovedFromSource: true,
        adoWorkItemId: true,
        adoProject: true,
        adoRemovedFromSource: true,
        githubIssueId: true,
        githubRemovedFromSource: true,
      },
    }),
  ]);

  const boardNames: Record<string, string> = Object.fromEntries(
    boards.map((b) => [b.id, b.name]),
  );

  const map = new Map<string, Set<string>>();
  const rowMap = new Map<string, Set<string>>();

  const addTo = (target: Map<string, Set<string>>, kind: string, key: string, boardId: string): void => {
    const k = `${kind}|${key}`;
    if (!target.has(k)) target.set(k, new Set());
    target.get(k)!.add(boardId);
  };

  const add = (kind: string, key: string, boardId: string): void => addTo(map, kind, key, boardId);

  for (const s of gh) add('gh', s.gitHubRepoSync.repoFullName, s.boardId);
  for (const s of ado) add('ado', s.azureDevOpsProjectSync.adoProject, s.boardId);
  for (const s of jira) add('jira', s.jiraProjectSync.jiraProjectKey, s.boardId);

  // `lookup` gates GitHub/ADO on useForIntelligence, so the row index must too —
  // otherwise a board deliberately excluded from intelligence regains assignment
  // chips through its promoted rows, and the flag means two different things
  // depending on which signal type reaches it. (Jira sources carry no such flag.)
  const intelBoards: Record<'gh' | 'ado' | 'jira', Set<string>> = {
    gh: new Set(gh.map((s) => s.boardId)),
    ado: new Set(ado.map((s) => s.boardId)),
    jira: new Set(jira.map((s) => s.boardId)),
  };

  // Row keys come from the shared builders so both sides of the ClickHouse↔Postgres
  // join stay byte-identical; see row-keys.ts.
  //
  // `*RemovedFromSource` is checked per provider key, not per row: one row can carry
  // keys for two providers, and a Jira removal must not suppress its live ADO key.
  // A removed row still sits on the board but no longer matches its source filter,
  // so it must not credit anyone — 41% of Jira rows and every GitHub row in staging
  // are in that state, and after the parent fallback a single stale epic would
  // credit its board for every story underneath it.
  for (const r of rows) {
    const boardId = r.boardId;
    if (!boardId) continue;
    if (r.jiraKey && !r.jiraRemovedFromSource && intelBoards.jira.has(boardId)) {
      addTo(rowMap, 'jira', jiraRowKey(r.jiraKey), boardId);
    }
    if (r.adoWorkItemId != null && r.adoProject && !r.adoRemovedFromSource && intelBoards.ado.has(boardId)) {
      addTo(rowMap, 'ado', adoRowKey(r.adoProject, r.adoWorkItemId), boardId);
    }
    if (r.githubIssueId && !r.githubRemovedFromSource && intelBoards.gh.has(boardId)) {
      // Already stored as "owner/repo#number" by the promote service.
      addTo(rowMap, 'gh', r.githubIssueId, boardId);
    }
  }

  return {
    boardNames,
    lookup: (kind, key) => [...(map.get(`${kind}|${key}`) ?? [])],
    lookupRow: (kind, rowKey) => (rowKey ? [...(rowMap.get(`${kind}|${rowKey}`) ?? [])] : []),
  };
}
