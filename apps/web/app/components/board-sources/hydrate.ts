// `any` is intentional at this serialization boundary: API responses carry
// dynamically-typed Prisma include trees that vary per provider.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SourceShape } from './BoardSourceCard';

export function hydrateJira(row: Record<string, unknown>): SourceShape {
  const r = row as any;
  return {
    id: r.id,
    provider: 'jira',
    name: r.jiraProjectSync?.jiraProjectKey ?? r.jiraProjectKey ?? '(unknown)',
    instanceId: r.jiraProjectSync?.jiraInstanceId ?? r.jiraProjectSync?.jiraInstance?.id ?? '',
    // BoardJiraSource only stores `lastPromotedAt`; the "last sync" timestamp
    // the UI cares about lives on the related JiraProjectSync row.
    lastSyncedAt: r.jiraProjectSync?.lastSyncedAt ?? r.lastSyncedAt ?? null,
    fieldMappings: r.fieldMappings ?? {},
    zoneValue: {
      syncIssuesToBoard: r.syncIssuesToBoard ?? true,
      targetGroupId: r.targetGroupId ?? null,
      allowedIssueTypes: r.allowedIssueTypes ?? [],
      jqlFilter: r.jqlFilter ?? null,
      statusMapping: r.statusMapping ?? {},
    },
  };
}

export function hydrateGitHub(row: Record<string, unknown>): SourceShape {
  const r = row as any;
  return {
    id: r.id,
    provider: 'github',
    name: r.gitHubRepoSync?.repoFullName ?? r.repoFullName ?? '(unknown)',
    instanceId: r.gitHubRepoSync?.githubInstanceId ?? r.gitHubRepoSync?.githubInstance?.id ?? '',
    // The bulk-repo sync model tracks last sync as `lastSuccessAt`.
    lastSyncedAt: r.gitHubRepoSync?.lastSuccessAt ?? r.gitHubRepoSync?.lastSyncedAt ?? r.lastSyncedAt ?? null,
    syncIssuesToBoard: r.syncIssuesToBoard ?? true,
    useForIntelligence: r.useForIntelligence ?? true,
    connection: {
      // Task 16: the bulk-repo sync model always pulls PRs and commits per
      // tier; per-repo opt-outs were removed. Surface as always-on for the
      // UI so existing components don't render as "off".
      syncPrs: true,
      syncCommits: true,
      aiAssistDetectedPct: null,
    },
    zoneValue: {
      syncIssuesToBoard: r.syncIssuesToBoard ?? true,
      targetGroupId: r.targetGroupId ?? null,
      allowedLabels: r.allowedLabels ?? [],
      allowedTypes: r.allowedTypes ?? [],
      includeClosedIssues: r.includeClosedIssues ?? false,
      statusMapping: r.statusMapping ?? {},
    },
  };
}

export function hydrateAdo(row: Record<string, unknown>): SourceShape {
  const r = row as any;
  return {
    id: r.id,
    provider: 'ado',
    name: r.azureDevOpsProjectSync?.adoProject ?? r.adoProject ?? '(unknown)',
    // The board source references the shared project sync; the id lets the
    // wizard PATCH the connection's code-sync scope inline.
    azureDevOpsProjectSyncId: r.azureDevOpsProjectSyncId ?? r.azureDevOpsProjectSync?.id ?? '',
    instanceId:
      r.azureDevOpsProjectSync?.azureDevOpsInstanceId ??
      r.azureDevOpsProjectSync?.azureDevOpsInstance?.id ??
      '',
    lastSyncedAt: r.azureDevOpsProjectSync?.lastSyncedAt ?? r.lastSyncedAt ?? null,
    syncWorkItemsToBoard: r.syncWorkItemsToBoard ?? true,
    useForIntelligence: r.useForIntelligence ?? true,
    // Board-source-level: which repositories THIS board's engineering-intelligence
    // widgets show. Deliberately separate from `connection.syncRepos` below, which
    // is the shared project sync's ingest scope — do not merge the two. Defaults to
    // [] for a row predating the migration (or a fixture that omits it), where []
    // means "all repositories".
    intelligenceRepos: r.intelligenceRepos ?? [],
    connection: {
      syncPrs: r.azureDevOpsProjectSync?.syncPrs ?? false,
      syncCommits: r.azureDevOpsProjectSync?.syncCommits ?? false,
      syncRepos: r.azureDevOpsProjectSync?.syncRepos ?? [],
      syncAllRepos: r.azureDevOpsProjectSync?.syncAllRepos ?? false,
      aiAssistDetectedPct: null,
    },
    zoneValue: {
      syncWorkItemsToBoard: r.syncWorkItemsToBoard ?? true,
      targetGroupId: r.targetGroupId ?? null,
      allowedWorkItemTypes: r.allowedWorkItemTypes ?? [],
      wiqlFilter: r.wiqlFilter ?? null,
      statusMapping: r.statusMapping ?? {},
      // This board's work-item scope (Task 6/9): governs BOTH which of the
      // project's area paths become synced cards on this board AND which the
      // engineering-intelligence widgets count — not analytics alone. Lives
      // only here on the zone's draft object; AdoBoardZone's AreaPathPicker
      // reads/writes it through `draft`/`setDraft`.
      areaPaths: r.areaPaths ?? [],
    },
  };
}

export function hydrateGitLab(row: Record<string, unknown>): SourceShape {
  const r = row as any;
  return {
    id: r.id,
    provider: 'gitlab',
    name: r.gitlabProjectSync?.projectPath ?? r.projectPath ?? '(unknown)',
    instanceId: r.gitlabProjectSync?.gitlabInstanceId ?? r.gitlabProjectSync?.gitlabInstance?.id ?? '',
    lastSyncedAt: r.gitlabProjectSync?.lastSyncedAt ?? r.lastSyncedAt ?? null,
    zoneValue: {
      syncIssuesToBoard: r.syncIssuesToBoard ?? false,
      syncMrsToBoard: r.syncMrsToBoard ?? false,
      targetGroupId: r.targetGroupId ?? null,
    },
  };
}
