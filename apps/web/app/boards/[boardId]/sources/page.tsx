// `any` is intentional at this serialization boundary: API responses carry
// dynamically-typed Prisma include trees that vary per provider.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BoardSourcesList } from '../../../components/board-sources/BoardSourcesList';
import {
  hydrateJira,
  hydrateGitHub,
  hydrateAdo,
  hydrateGitLab,
} from '../../../components/board-sources/hydrate';
import type { SourceShape } from '../../../components/board-sources/BoardSourceCard';
import type { ReadyProviders } from '../../../components/board-sources/BoardAddSource';
import {
  listBoardJiraSources,
  listBoardGitHubSources,
  listBoardAdoSources,
  listBoardGitLabSources,
  listGitHubRepoSyncs,
  listAdoProjectSyncs,
  listGitLabProjectSyncs,
} from '../../../actions/board-sources';
import { listJiraProjectSyncs } from '../../../actions/connections';
import { fetchGroups } from '../../../actions/projects';
import { fetchBoardStatuses } from '../../../actions/board-statuses';
import { fetchGitHubInstances } from '../../../actions/github';
import { getBoardKind } from '../../../actions/board-tree';
import { getBootstrapState } from '../../../actions/organization';
import { isOrganizationAdmin } from '../../../lib/org-role';
import { boardCapabilities } from '@deckgauge/shared';
import { CalendarSourceScreen } from '../../../components/CalendarSourceScreen';

export const dynamic = 'force-dynamic';

export default async function BoardSourcesPage({ params }: { params: { boardId: string } }) {
  const [
    jiraSources,
    jiraSyncs,
    ghSources,
    ghSyncs,
    adoSources,
    adoSyncs,
    glSources,
    glSyncs,
    groups,
    boardStatuses,
  ] = await Promise.all([
    listBoardJiraSources(params.boardId).catch(() => []),
    listJiraProjectSyncs().catch(() => []),
    listBoardGitHubSources(params.boardId).catch(() => []),
    listGitHubRepoSyncs().catch(() => []),
    listBoardAdoSources(params.boardId).catch(() => []),
    listAdoProjectSyncs().catch(() => []),
    listBoardGitLabSources(params.boardId).catch(() => []),
    listGitLabProjectSyncs().catch(() => []),
    fetchGroups(params.boardId).catch(() => [] as { id: string; name: string; color: string }[]),
    fetchBoardStatuses(params.boardId).catch(
      () => [] as { id: string; label: string; color: string }[],
    ),
  ]);

  // This tab is a picker over connections the organization already has, which a
  // member may use. Rotating a connection's token is not: refresh-token is
  // orgRole(ADMIN), so the reconnect affordances are withheld from members
  // rather than shown and answered with a 403.
  const [orgState, board] = await Promise.all([
    getBootstrapState(),
    getBoardKind(params.boardId).catch(() => null),
  ]);
  const canManageConnections = isOrganizationAdmin(orgState);

  const showCalendarSource = boardCapabilities(board?.kind ?? '').calendarSource;

  const githubInstances = (await fetchGitHubInstances().catch(() => [])) as Array<{
    id: string;
    baseUrl?: string | null;
  }>;

  const usedJira = new Set((jiraSources as any[]).map((s) => s.jiraProjectSyncId));
  const usedGh = new Set((ghSources as any[]).map((s) => s.gitHubRepoSyncId));
  const usedAdo = new Set((adoSources as any[]).map((s) => s.azureDevOpsProjectSyncId));
  const usedGl = new Set((glSources as any[]).map((s) => s.gitlabProjectSyncId));

  const readyProviders: ReadyProviders = {
    jira: (jiraSyncs as any[])
      .filter((s) => !usedJira.has(s.id))
      .map((s) => ({ id: s.id, label: s.jiraProjectKey })),
    github: (ghSyncs as any[])
      .filter((s) => !usedGh.has(s.id))
      .map((s) => ({
        id: s.id,
        label: s.repoFullName,
        // Task 16 dropped per-repo syncPrs/syncCommits flags — bulk-bind always
        // syncs the full intelligence payload, so codeState is no longer
        // meaningful and is omitted (optional on ReadyProviderEntry).
      })),
    ado: (adoSyncs as any[])
      .filter((s) => !usedAdo.has(s.id))
      .map((s) => ({ id: s.id, label: s.adoProject })),
    gitlab: (glSyncs as any[])
      .filter((s) => !usedGl.has(s.id))
      .map((s) => ({ id: s.id, label: s.projectPath })),
  };

  const initialSources: SourceShape[] = [
    ...(jiraSources as any[]).map((r) => hydrateJira(r as Record<string, unknown>)),
    ...(ghSources as any[]).map((r) => hydrateGitHub(r as Record<string, unknown>)),
    ...(adoSources as any[]).map((r) => hydrateAdo(r as Record<string, unknown>)),
    ...(glSources as any[]).map((r) => hydrateGitLab(r as Record<string, unknown>)),
  ];

  return (
    <>
      {showCalendarSource && (
        <section className="mb-6 rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Interview calendar</h2>
          <CalendarSourceScreen boardId={params.boardId} />
        </section>
      )}
      <BoardSourcesList
        boardId={params.boardId}
        initialSources={initialSources}
        groups={(groups as Array<{ id: string; name: string }>).map((g) => ({
          id: g.id,
          name: g.name,
        }))}
        readyProviders={readyProviders}
        boardStatuses={boardStatuses.map((s) => ({ id: s.id, label: s.label, color: s.color }))}
        githubInstances={githubInstances.map((i) => ({
          id: i.id,
          label: i.baseUrl ?? i.id,
        }))}
        canManageConnections={canManageConnections}
      />
    </>
  );
}
