'use client';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { BulkBindRequest } from '@deckgauge/shared';
import {
  BoardSourceCard,
  type SourceShape,
  type AdoConnectionPatch,
  type SourceSyncOutcome,
} from './BoardSourceCard';
import { runSyncAfterSave } from '../../utils/board-sync-runner';
import {
  BoardAddSource,
  type ReadyProviders,
  type CartItem,
  type AttachResult,
} from './BoardAddSource';
import { SourcesEmptyState } from './SourcesEmptyState';
import type { GitHubInstanceOption, BulkAttachResult } from './GitHubSourcePicker';
import { hydrateJira, hydrateGitHub, hydrateAdo, hydrateGitLab } from './hydrate';
import type { BoardStatusOption } from './StatusMappingEditor';
import { fetchBoardSourceHealth, type SourceHealth } from '../../actions/board-sync';
import {
  patchBoardJiraSource,
  patchBoardGitHubSource,
  patchBoardAdoSource,
  patchBoardGitLabSource,
  detachBoardJiraSource,
  detachBoardGitHubSource,
  detachBoardAdoSource,
  detachBoardGitLabSource,
  attachBoardJiraSource,
  attachBoardGitHubSource,
  attachBoardAdoSource,
  attachBoardGitLabSource,
  ensureJiraProjectSync,
  ensureGitHubRepoSync,
  ensureAdoProjectSync,
  ensureGitLabProjectSync,
  listBoardGitHubSources,
} from '../../actions/board-sources';
import {
  updateAdoProjectSync,
  refreshJiraToken,
  refreshGitHubToken,
  refreshAdoToken,
  refreshGitLabToken,
} from '../../actions/connections';
import type { RemoteProjectsResult } from '../../actions/board-sources';
import { bulkAddGitHubRepos } from '../../actions/github-sources';
// Only reads here. Creating, editing and testing a connection require the
// organization ADMIN role and live on Settings → Connections; this list is a
// picker over connections the organization already has.
import { fetchJiraInstances, discoverJiraProjects } from '../../actions/jira';
import { fetchGitHubInstances, discoverGitHubRepos } from '../../actions/github';
import { fetchAzureDevOpsInstances, listAzureDevOpsRemoteProjects } from '../../actions/azure-devops';
import { fetchGitLabInstances, listGitLabRemoteProjects } from '../../actions/gitlab';
import type { AddNewActions, Provider } from './BoardAddSource';

interface Props {
  boardId: string;
  initialSources: SourceShape[];
  groups: Array<{ id: string; name: string }>;
  readyProviders: ReadyProviders;
  boardStatuses: BoardStatusOption[];
  /** GitHub connections available to this board; enables the live repo picker. */
  githubInstances?: GitHubInstanceOption[];
  /**
   * Whether the viewer holds the organization ADMIN role, which is what
   * rotating a connection's token needs (`POST
   * /:provider/instances/:id/refresh-token`). Withholding it hides both
   * reconnect affordances on this tab: the card's inline fix box and the
   * add-source wizard's auth-failure banner.
   *
   * Defaults to `true` — presentation only, the API enforces regardless, and the
   * board Sources page always passes the viewer's real role.
   */
  canManageConnections?: boolean;
}

export function BoardSourcesList({
  boardId,
  initialSources,
  groups,
  readyProviders,
  boardStatuses,
  githubInstances = [],
  canManageConnections = true,
}: Props) {
  const [sources, setSources] = useState<SourceShape[]>(initialSources);
  const [addOpen, setAddOpen] = useState(false);
  const [addProvider, setAddProvider] = useState<Provider | undefined>(undefined);
  const [health, setHealth] = useState<Record<string, SourceHealth>>({});
  const router = useRouter();
  const searchParams = useSearchParams();
  const fixInstanceId = searchParams.get('fix')?.split(':')[1] ?? null;

  useEffect(() => {
    let active = true;
    fetchBoardSourceHealth(boardId).then((h) => {
      if (active && h) {
        setHealth(Object.fromEntries(h.sources.map((s) => [s.instanceId, s.state])));
      }
    });
    return () => {
      active = false;
    };
  }, [boardId]);

  const openAddSource = (provider?: Provider) => {
    setAddProvider(provider);
    setAddOpen(true);
  };
  const closeAddSource = () => {
    setAddOpen(false);
    setAddProvider(undefined);
  };

  const catalogEmpty =
    readyProviders.jira.length === 0 &&
    readyProviders.github.length === 0 &&
    readyProviders.ado.length === 0 &&
    readyProviders.gitlab.length === 0;

  async function handleSave(
    source: SourceShape,
    patch: Record<string, unknown>,
    connectionPatch?: AdoConnectionPatch
  ) {
    let updated: SourceShape | null = null;
    if (source.provider === 'jira') {
      const row = await patchBoardJiraSource(boardId, source.id, patch as never);
      updated = hydrateJira({
        ...row,
        jiraProjectSync: { jiraProjectKey: source.name, jiraInstanceId: source.instanceId },
      });
    } else if (source.provider === 'github') {
      const row = await patchBoardGitHubSource(boardId, source.id, patch as never);
      updated = hydrateGitHub({
        ...row,
        gitHubRepoSync: {
          repoFullName: source.name,
          syncPrs: source.connection.syncPrs,
          syncCommits: source.connection.syncCommits,
          githubInstanceId: source.instanceId,
        },
      });
    } else if (source.provider === 'ado') {
      // Code-sync scope lives on the shared project sync — persist it separately.
      if (connectionPatch && source.azureDevOpsProjectSyncId) {
        await updateAdoProjectSync(source.azureDevOpsProjectSyncId, connectionPatch);
      }
      const conn = connectionPatch ?? {
        syncPrs: source.connection.syncPrs,
        syncCommits: source.connection.syncCommits,
        syncRepos: source.connection.syncRepos ?? [],
        syncAllRepos: source.connection.syncAllRepos ?? false,
      };
      const row = await patchBoardAdoSource(boardId, source.id, patch as never);
      updated = hydrateAdo({
        ...row,
        azureDevOpsProjectSyncId: source.azureDevOpsProjectSyncId,
        azureDevOpsProjectSync: {
          id: source.azureDevOpsProjectSyncId,
          adoProject: source.name,
          syncPrs: conn.syncPrs,
          syncCommits: conn.syncCommits,
          syncRepos: conn.syncRepos,
          syncAllRepos: conn.syncAllRepos,
          azureDevOpsInstanceId: source.instanceId,
        },
      });
    } else if (source.provider === 'gitlab') {
      const row = await patchBoardGitLabSource(boardId, source.id, patch as never);
      updated = hydrateGitLab({
        ...row,
        gitlabProjectSync: { projectPath: source.name, gitlabInstanceId: source.instanceId },
      });
    }
    if (updated) {
      const finalUpdated = updated;
      setSources((prev) => prev.map((s) => (s.id === finalUpdated.id ? finalUpdated : s)));
    }
  }

  // A saved source config only changes what the board shows once a sync has run
  // against it, so saving triggers one and then re-renders the board's server data.
  async function handleSyncAfterSave(): Promise<SourceSyncOutcome> {
    const outcome = await runSyncAfterSave(boardId);
    router.refresh();
    return outcome;
  }

  // Removing a Jira field mapping doesn't touch the column it produced (see
  // synced-column.service's detachJiraField), so unlike handleSyncAfterSave
  // there is nothing for a sync to populate — a plain server-data refresh is
  // the whole fix.
  function handleFieldUnmapped(): void {
    router.refresh();
  }

  async function handleDetach(source: SourceShape) {
    if (source.provider === 'jira') await detachBoardJiraSource(boardId, source.id);
    if (source.provider === 'github') await detachBoardGitHubSource(boardId, source.id);
    if (source.provider === 'ado') await detachBoardAdoSource(boardId, source.id);
    if (source.provider === 'gitlab') await detachBoardGitLabSource(boardId, source.id);
    setSources((prev) => prev.filter((s) => s.id !== source.id));
  }

  const appendRow = (row: SourceShape) => setSources((prev) => [...prev, row]);

  async function handleAttachMany(items: CartItem[]): Promise<AttachResult[]> {
    const results: AttachResult[] = [];
    for (const item of items) {
      try {
        if (item.provider === 'jira') {
          const outcome = await attachBoardJiraSource({ boardId, jiraProjectSyncId: item.syncId });
          if (!outcome.ok) {
            results.push({ item, ok: false, error: outcome.error });
            continue;
          }
          appendRow(hydrateJira(outcome.row as unknown as Record<string, unknown>));
        } else if (item.provider === 'github') {
          const outcome = await attachBoardGitHubSource({
            boardId,
            gitHubRepoSyncId: item.syncId,
            syncIssuesToBoard: item.roles.syncIssuesToBoard,
            useForIntelligence: item.roles.useForIntelligence,
          });
          if (!outcome.ok) {
            results.push({ item, ok: false, error: outcome.error });
            continue;
          }
          appendRow(hydrateGitHub(outcome.row as unknown as Record<string, unknown>));
        } else if (item.provider === 'ado') {
          const outcome = await attachBoardAdoSource({
            boardId,
            azureDevOpsProjectSyncId: item.syncId,
            syncWorkItemsToBoard: item.roles.syncWorkItemsToBoard,
            useForIntelligence: item.roles.useForIntelligence,
          });
          if (!outcome.ok) {
            results.push({ item, ok: false, error: outcome.error });
            continue;
          }
          appendRow(hydrateAdo(outcome.row as unknown as Record<string, unknown>));
        } else if (item.provider === 'gitlab') {
          const outcome = await attachBoardGitLabSource({
            boardId,
            gitlabProjectSyncId: item.syncId,
            syncIssuesToBoard: item.roles.syncIssuesToBoard,
            syncMrsToBoard: item.roles.syncMrsToBoard,
          });
          if (!outcome.ok) {
            results.push({ item, ok: false, error: outcome.error });
            continue;
          }
          appendRow(hydrateGitLab(outcome.row as unknown as Record<string, unknown>));
        }
        results.push({ item, ok: true });
      } catch (e) {
        results.push({ item, ok: false, error: e instanceof Error ? e.message : 'attach failed' });
      }
    }
    return results;
  }

  // GitHub bulk-bind: provisions repos (tiering + backfill) and links them to
  // the board. The response carries only counts, so re-fetch the board's GitHub
  // sources and swap them into local state to surface the new rows immediately.
  async function handleBulkAttachGitHub(req: BulkBindRequest): Promise<BulkAttachResult> {
    try {
      const summary = await bulkAddGitHubRepos(boardId, req);
      const ghRows = await listBoardGitHubSources(boardId);
      const ghSources = ghRows.map((row) =>
        hydrateGitHub(row as unknown as Record<string, unknown>)
      );
      setSources((prev) => [...prev.filter((s) => s.provider !== 'github'), ...ghSources]);
      return {
        ok: true,
        message: `Added ${summary.addedCount}, re-enabled ${summary.reEnabledCount}, skipped ${summary.skippedCount}.`,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Bulk add failed.' };
    }
  }

  // Replace an expired connection token via the shipped validate-before-swap
  // refresh endpoints (the API tests the new token and only swaps on success).
  async function handleReplaceToken(
    provider: Provider,
    connectionId: string,
    token: string,
  ): Promise<{ ok: boolean; error?: string }> {
    switch (provider) {
      case 'jira':
        return refreshJiraToken(connectionId, token);
      case 'github':
        return refreshGitHubToken(connectionId, token);
      case 'ado':
        return refreshAdoToken(connectionId, token);
      case 'gitlab':
        return refreshGitLabToken(connectionId, token);
    }
  }

  // Repos/projects already attached to this board, keyed `${provider}:${name}`.
  // Passed to the picker so already-attached sources are hidden (matched by the
  // human-readable name, since the remote picker lists names, not sync ids).
  const attachedKeys = new Set(sources.map((s) => `${s.provider}:${s.name}`));

  const addNewActions: AddNewActions = {
    listConnections: async (provider: Provider) => {
      if (provider === 'jira') {
        const rows = (await fetchJiraInstances()) as Array<{ id: string; name?: string }>;
        return rows.map((r) => ({ id: r.id, name: r.name ?? r.id }));
      }
      if (provider === 'github') {
        const rows = (await fetchGitHubInstances()) as Array<{ id: string; baseUrl?: string }>;
        return rows.map((r) => ({ id: r.id, name: r.baseUrl ?? r.id }));
      }
      if (provider === 'ado') {
        const rows = (await fetchAzureDevOpsInstances()) as Array<{ id: string; name?: string }>;
        return rows.map((r) => ({ id: r.id, name: r.name ?? r.id }));
      }
      const rows = (await fetchGitLabInstances()) as Array<{ id: string; name?: string }>;
      return rows.map((r) => ({ id: r.id, name: r.name ?? r.id }));
    },
    listRemoteProjects: async (
      provider: Provider,
      connectionId: string,
      search?: string,
    ): Promise<RemoteProjectsResult> => {
      if (provider === 'jira') return discoverJiraProjects(connectionId);
      if (provider === 'github') {
        const repos = await discoverGitHubRepos(connectionId);
        return { ok: true, projects: repos };
      }
      if (provider === 'ado') return listAzureDevOpsRemoteProjects(connectionId);
      // GitLab searches server-side: instances can hold thousands of projects
      // the token can see but isn't a member of, so a client-side filter over a
      // capped list isn't enough.
      return listGitLabRemoteProjects(connectionId, search);
    },
    ensureSync: async (provider: Provider, connectionId: string, projectKey: string) => {
      if (provider === 'jira') {
        const { id } = await ensureJiraProjectSync(connectionId, projectKey);
        return { syncId: id, label: projectKey };
      }
      if (provider === 'github') {
        const { id } = await ensureGitHubRepoSync(connectionId, projectKey);
        return { syncId: id, label: projectKey };
      }
      if (provider === 'ado') {
        const { id } = await ensureAdoProjectSync(connectionId, projectKey);
        return { syncId: id, label: projectKey };
      }
      const { id } = await ensureGitLabProjectSync(connectionId, projectKey);
      return { syncId: id, label: projectKey };
    },
  };

  return (
    <main className="space-y-3 px-6 py-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Sources</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {sources.length} {sources.length === 1 ? 'source' : 'sources'} attached to this board
          </p>
        </div>
        <button
          type="button"
          className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-sm font-medium"
          onClick={() => openAddSource()}
        >
          + Add source
        </button>
      </header>

      {addOpen && (
        <BoardAddSource
          boardId={boardId}
          readyProviders={readyProviders}
          attachedKeys={attachedKeys}
          initialProvider={addProvider}
          onCancel={closeAddSource}
          onAttachMany={handleAttachMany}
          addNewActions={addNewActions}
          githubInstances={githubInstances}
          onBulkAttachGitHub={handleBulkAttachGitHub}
          onReplaceToken={canManageConnections ? handleReplaceToken : undefined}
        />
      )}

      {sources.length === 0 && !addOpen ? (
        <SourcesEmptyState catalogEmpty={catalogEmpty} onConnect={(p) => openAddSource(p)} />
      ) : (
        sources.map((s) => (
          <BoardSourceCard
            key={s.id}
            boardId={boardId}
            source={s}
            groups={groups}
            boardStatuses={boardStatuses}
            onSave={(patch, connectionPatch) => handleSave(s, patch, connectionPatch)}
            onSyncAfterSave={handleSyncAfterSave}
            onFieldUnmapped={handleFieldUnmapped}
            onSaveStatusMapping={(m) => handleSave(s, { statusMapping: m })}
            onDetach={() => handleDetach(s)}
            health={health[s.instanceId]}
            openFix={fixInstanceId === s.instanceId}
            canManageConnections={canManageConnections}
          />
        ))
      )}
    </main>
  );
}
