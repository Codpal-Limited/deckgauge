// "Add item by source link": a user pastes a link to ONE item in a connected
// source (a Jira issue, a GitHub issue, an Azure DevOps work item) into a group's
// add-item row, and that item is loaded onto the board in that group.
//
// The link must resolve to a source ALREADY ATTACHED to this board — the same
// Jira site + project, GitHub repo, or ADO organization + project. That is what
// makes the row a synced row the board's sync keeps current, rather than a
// one-off copy that silently goes stale. Everything is resolved from the board's
// own source rows, never from the request, and the credential comes through the
// tenant-scoped adapter factories (`source-adapters.ts`).
//
// The row is flagged `linkedFromSource`. A user who pastes a link almost always
// wants something the board's scope (issue types, JQL, labels) did NOT already
// promote — otherwise it would be on the board — so the promote services keep
// updating linked rows whatever the scope says, and never flag them removed for
// scope alone (jira-promote.service.ts, github-promote.service.ts; the ADO
// promote already does this for every existing row).
//
// The row is written here, synchronously, so the user sees the item at once with
// the fields every provider carries (name, description, assignee, status). A
// sync of that one source is then queued to reconcile what only the promote
// path computes — mapped custom columns, a status the board does not yet have.

import type { PrismaClient } from '@deckgauge/db';
import {
  adoOrgKey,
  githubWebHost,
  jiraSiteHost,
  LEGACY_STATUS_LABELS,
  parseSourceItemLink,
  type AzureDevOpsPort,
  type GitHubPort,
  type ImportSourceLinkResult,
  type JiraPort,
  type ProjectStatus,
} from '@deckgauge/shared';

export type SourceLinkErrorCode =
  | 'unrecognized_link'
  | 'group_not_on_board'
  | 'not_a_board_source'
  | 'not_found'
  | 'already_on_board'
  | 'source_unavailable';

const STATUS_BY_CODE: Record<SourceLinkErrorCode, number> = {
  unrecognized_link: 400,
  group_not_on_board: 400,
  not_a_board_source: 422,
  not_found: 404,
  already_on_board: 409,
  source_unavailable: 502,
};

/** A refusal whose message is written for the person who pasted the link. */
export class SourceLinkError extends Error {
  readonly status: number;
  constructor(
    readonly code: SourceLinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SourceLinkError';
    this.status = STATUS_BY_CODE[code];
  }
}

export interface SourceLinkAdapters {
  jira: (organizationId: string, instanceId: string) => Promise<JiraPort>;
  github: (organizationId: string, instanceId: string) => Promise<GitHubPort>;
  ado: (organizationId: string, instanceId: string) => Promise<AzureDevOpsPort>;
}

/** Queue a promote sync of one source key: a Jira project, a repo, an ADO project. */
export type EnqueueSourceSync = (job: {
  provider: 'jira' | 'github' | 'ado';
  instanceId: string;
  key: string;
}) => Promise<void>;

export interface ImportFromLinkInput {
  organizationId: string;
  boardId: string;
  groupId: string;
  url: string;
}

/** What every provider contributes to the new row, before its identity fields. */
interface CommonFields {
  name: string;
  description: string | null;
  person: string;
  sourceStatus: string;
  dueDate: Date | null;
  statusMapping: Record<string, string>;
}

export class SourceLinkImportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly adapters: SourceLinkAdapters,
    private readonly enqueueSync: EnqueueSourceSync,
  ) {}

  async importFromLink(input: ImportFromLinkInput): Promise<ImportSourceLinkResult> {
    const group = await this.prisma.group.findFirst({
      where: { id: input.groupId, boardId: input.boardId },
      select: { id: true },
    });
    if (!group) {
      throw new SourceLinkError('group_not_on_board', 'That group is not on this board.');
    }

    const parsed = parseSourceItemLink(input.url);
    if (!parsed) {
      throw new SourceLinkError(
        'unrecognized_link',
        'That is not a link to a Jira issue, GitHub issue or Azure DevOps work item.',
      );
    }

    switch (parsed.provider) {
      case 'jira':
        return this.importJira(input, parsed.host, parsed.issueKey);
      case 'github':
        return this.importGitHub(input, parsed.host, parsed.repoFullName, parsed.number);
      case 'ado':
        return this.importAdo(input, parsed.orgKey, parsed.workItemId);
    }
  }

  // ── Jira ──────────────────────────────────────────────────────────────────

  private async importJira(
    input: ImportFromLinkInput,
    host: string,
    issueKey: string,
  ): Promise<ImportSourceLinkResult> {
    const sources = await this.prisma.boardJiraSource.findMany({
      where: { boardId: input.boardId },
      include: {
        jiraProjectSync: {
          select: {
            jiraProjectKey: true,
            jiraInstance: { select: { id: true, atlassianUrl: true } },
          },
        },
      },
    });
    const onSite = sources.filter(
      (s) => jiraSiteHost(s.jiraProjectSync.jiraInstance.atlassianUrl) === host,
    );
    if (onSite.length === 0) {
      throw notASource(`This board has no Jira source on ${host}.`);
    }

    // Several board sources may share one site; any of their connections can
    // read the issue, and the project check below picks the source it lands in.
    const instanceId = onSite[0]!.jiraProjectSync.jiraInstance.id;
    const adapter = await this.adapters.jira(input.organizationId, instanceId);
    if (!adapter.fetchIssue) {
      throw new SourceLinkError('source_unavailable', 'This Jira connection cannot load single issues.');
    }
    const issue = await callSource('Jira', () => adapter.fetchIssue!(issueKey));
    if (!issue) {
      throw new SourceLinkError('not_found', `Jira could not find ${issueKey}, or this connection cannot see it.`);
    }

    // The FETCHED project, not the one in the link: a moved issue keeps
    // resolving by its old key, and the sync keys rows by where it lives now.
    const source = onSite.find((s) => s.jiraProjectSync.jiraProjectKey === issue.projectKey);
    if (!source) {
      throw notASource(`${issue.key} is in Jira project ${issue.projectKey}, which is not a source of this board.`);
    }

    await this.refuseDuplicate(input.boardId, { jiraKey: issue.key, jiraProjectKey: issue.projectKey }, issue.key);

    return this.create(
      input,
      {
        name: issue.summary,
        description: issue.description ?? null,
        person: issue.assignee ?? '',
        sourceStatus: issue.status,
        dueDate: issue.dueDate ?? null,
        statusMapping: asStringRecord(source.statusMapping),
      },
      {
        jiraKey: issue.key,
        jiraProjectKey: issue.projectKey,
        jiraType: issue.type,
        jiraSyncedFields: source.defaultSyncedFields ?? undefined,
        jiraRemovedFromSource: false,
      },
      { source: 'JIRA', externalId: issue.key },
      {
        provider: 'jira',
        sourceRef: issue.key,
        job: { provider: 'jira', instanceId: source.jiraProjectSync.jiraInstance.id, key: issue.projectKey },
      },
    );
  }

  // ── GitHub ────────────────────────────────────────────────────────────────

  private async importGitHub(
    input: ImportFromLinkInput,
    host: string,
    repoFullName: string,
    number: number,
  ): Promise<ImportSourceLinkResult> {
    const sources = await this.prisma.boardGitHubSource.findMany({
      where: { boardId: input.boardId },
      include: {
        gitHubRepoSync: {
          select: {
            repoFullName: true,
            githubInstance: { select: { id: true, baseUrl: true } },
          },
        },
      },
    });
    // GitHub repo names are case-insensitive; the STORED spelling is what the
    // sync builds `githubIssueId` from, so it is the one used from here on.
    const source = sources.find(
      (s) =>
        githubWebHost(s.gitHubRepoSync.githubInstance.baseUrl) === host &&
        s.gitHubRepoSync.repoFullName.toLowerCase() === repoFullName.toLowerCase(),
    );
    if (!source) {
      throw notASource(`${repoFullName} is not a GitHub source of this board.`);
    }
    if (source.syncIssuesToBoard === false) {
      throw notASource(`${source.gitHubRepoSync.repoFullName} is attached for intelligence only — its issues are not synced to this board.`);
    }

    const storedRepo = source.gitHubRepoSync.repoFullName;
    const adapter = await this.adapters.github(input.organizationId, source.gitHubRepoSync.githubInstance.id);
    if (!adapter.fetchIssue) {
      throw new SourceLinkError('source_unavailable', 'This GitHub connection cannot load single issues.');
    }
    const issue = await callSource('GitHub', () => adapter.fetchIssue!(storedRepo, number));
    if (!issue) {
      throw new SourceLinkError('not_found', `GitHub could not find issue #${number} in ${storedRepo}.`);
    }

    // The GitHub sync fetches OPEN issues only, so a closed one would be flagged
    // removed by the very sync this import queues. Refuse it plainly instead.
    if (issue.state !== 'open') {
      throw new SourceLinkError(
        'not_a_board_source',
        `Issue #${issue.number} in ${storedRepo} is closed — only open GitHub issues sync to a board.`,
      );
    }

    const githubIssueId = `${storedRepo}#${issue.number}`;
    await this.refuseDuplicate(input.boardId, { githubIssueId }, githubIssueId);

    return this.create(
      input,
      {
        name: issue.title,
        description: issue.body ?? null,
        person: issue.assigneeLogin ?? '',
        sourceStatus: issue.state,
        dueDate: null,
        statusMapping: asStringRecord(source.statusMapping),
      },
      {
        githubIssueId,
        githubRepoFullName: storedRepo,
        githubSyncedFields: source.defaultSyncedFields,
        githubRemovedFromSource: false,
      },
      { source: 'GITHUB', externalId: githubIssueId },
      {
        provider: 'github',
        sourceRef: githubIssueId,
        job: { provider: 'github', instanceId: source.gitHubRepoSync.githubInstance.id, key: storedRepo },
      },
    );
  }

  // ── Azure DevOps ──────────────────────────────────────────────────────────

  private async importAdo(
    input: ImportFromLinkInput,
    orgKey: string,
    workItemId: number,
  ): Promise<ImportSourceLinkResult> {
    const sources = await this.prisma.boardAdoSource.findMany({
      where: { boardId: input.boardId },
      include: {
        azureDevOpsProjectSync: {
          select: {
            adoProject: true,
            azureDevOpsInstance: { select: { id: true, orgUrl: true } },
          },
        },
      },
    });
    const inOrg = sources.filter(
      (s) => adoOrgKey(s.azureDevOpsProjectSync.azureDevOpsInstance.orgUrl) === orgKey,
    );
    if (inOrg.length === 0) {
      throw notASource(`This board has no Azure DevOps source in the ${orgKey} organization.`);
    }

    const instanceId = inOrg[0]!.azureDevOpsProjectSync.azureDevOpsInstance.id;
    const adapter = await this.adapters.ado(input.organizationId, instanceId);
    if (!adapter.fetchWorkItem) {
      throw new SourceLinkError('source_unavailable', 'This Azure DevOps connection cannot load single work items.');
    }
    const found = await callSource('Azure DevOps', () => adapter.fetchWorkItem!(workItemId));
    if (!found) {
      throw new SourceLinkError('not_found', `Azure DevOps could not find work item ${workItemId}.`);
    }

    const source = inOrg.find(
      (s) => s.azureDevOpsProjectSync.adoProject.toLowerCase() === found.project.toLowerCase(),
    );
    if (!source) {
      throw notASource(`Work item ${workItemId} is in project ${found.project}, which is not a source of this board.`);
    }
    if (source.syncWorkItemsToBoard === false) {
      throw notASource(`${source.azureDevOpsProjectSync.adoProject} is attached for intelligence only — its work items are not synced to this board.`);
    }

    const { item } = found;
    await this.refuseDuplicate(input.boardId, { adoWorkItemId: item.adoId }, String(item.adoId));

    return this.create(
      input,
      {
        name: item.title,
        description: item.description,
        person: item.assignedTo ?? '',
        sourceStatus: item.state,
        dueDate: null,
        statusMapping: asStringRecord(source.statusMapping),
      },
      {
        adoWorkItemId: item.adoId,
        adoProject: source.azureDevOpsProjectSync.adoProject,
        adoSyncedFields: source.defaultSyncedFields,
        adoRemovedFromSource: false,
      },
      { source: 'ADO', externalId: String(item.adoId) },
      {
        provider: 'ado',
        sourceRef: String(item.adoId),
        job: { provider: 'ado', instanceId, key: source.azureDevOpsProjectSync.adoProject },
      },
    );
  }

  // ── Shared ────────────────────────────────────────────────────────────────

  private async refuseDuplicate(
    boardId: string,
    identity: Record<string, string | number>,
    label: string,
  ): Promise<void> {
    const existing = await this.prisma.project.findFirst({
      where: { boardId, ...identity },
      select: { group: { select: { name: true } } },
    });
    if (existing) {
      const where = existing.group ? ` in "${existing.group.name}"` : '';
      throw new SourceLinkError('already_on_board', `${label} is already on this board${where}.`);
    }
  }

  private async create(
    input: ImportFromLinkInput,
    common: CommonFields,
    identity: Record<string, unknown>,
    exclusion: { source: 'JIRA' | 'GITHUB' | 'ADO'; externalId: string },
    meta: {
      provider: ImportSourceLinkResult['provider'];
      sourceRef: string;
      job: Parameters<EnqueueSourceSync>[0];
    },
  ): Promise<ImportSourceLinkResult> {
    const { statusId, legacy, label } = await this.resolveStatus(
      input.boardId,
      common.sourceStatus,
      common.statusMapping,
    );
    const agg = await this.prisma.project.aggregate({
      where: { groupId: input.groupId },
      _max: { order: true },
    });

    const project = await this.prisma.$transaction(async (tx) => {
      // Adding an item back by its link is an explicit choice that overrides an
      // earlier "delete from board" — otherwise the next sync would skip it.
      await tx.boardSyncExclusion.deleteMany({
        where: { boardId: input.boardId, source: exclusion.source, externalId: exclusion.externalId },
      });
      const row = await tx.project.create({
        data: {
          name: common.name,
          description: common.description,
          owner: common.person,
          assignee: common.person,
          status: legacy as ProjectStatus,
          statusId,
          dueDate: common.dueDate,
          boardId: input.boardId,
          groupId: input.groupId,
          order: (agg._max.order ?? 0) + 1,
          linkedFromSource: true,
          ...identity,
        },
      });
      await tx.projectStatusChange.create({
        data: {
          projectId: row.id,
          fromStatus: null,
          toStatus: label ?? legacy,
          changedBy: `link:${meta.provider}`,
        },
      });
      return row;
    }).catch((err: unknown) => {
      // Lost a race with a second submit of the same link, or with a sync that
      // promoted the item in between: the board's unique identity index answers.
      if (isUniqueViolation(err)) {
        throw new SourceLinkError('already_on_board', `${meta.sourceRef} is already on this board.`);
      }
      throw err;
    });

    try {
      await this.enqueueSync(meta.job);
    } catch {
      // Not fatal: the row exists with every field a provider carries, and the
      // next scheduled sync reconciles the rest.
    }

    return {
      projectId: project.id,
      name: project.name,
      provider: meta.provider,
      sourceRef: meta.sourceRef,
    };
  }

  /**
   * The board status a source status lands in, by the same first two rules the
   * promote services use: the board source's explicit mapping, then a
   * case-insensitive label match. Unlike a sync it never CREATES a status — a
   * status the board does not have yet is left for the queued sync to add.
   */
  private async resolveStatus(
    boardId: string,
    sourceStatus: string,
    mapping: Record<string, string>,
  ): Promise<{ statusId: string | null; legacy: ProjectStatus; label: string | null }> {
    const statuses = await this.prisma.boardStatus.findMany({
      where: { boardId },
      select: { id: true, label: true },
    });
    const byLabel = new Map(statuses.map((s) => [s.label.toLowerCase(), s]));
    const mapped = mapping[sourceStatus];
    const hit =
      (mapped && statuses.find((s) => s.id === mapped)) ||
      (mapped && byLabel.get((LEGACY_STATUS_LABELS[mapped] ?? mapped).toLowerCase())) ||
      byLabel.get(sourceStatus.toLowerCase()) ||
      null;
    if (!hit) return { statusId: null, legacy: 'NOT_STARTED', label: null };
    return { statusId: hit.id, legacy: legacyEnumFor(hit.label), label: hit.label };
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

function notASource(message: string): SourceLinkError {
  return new SourceLinkError('not_a_board_source', message);
}

/** A provider call whose failure is the source's, reported as such rather than as a 500. */
async function callSource<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SourceLinkError('source_unavailable', `${provider} could not be reached: ${detail}`);
  }
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  return out;
}

const ENUM_BY_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_STATUS_LABELS).map(([e, l]) => [l.toLowerCase(), e]),
);

function legacyEnumFor(label: string): ProjectStatus {
  return (ENUM_BY_LABEL[label.toLowerCase()] ?? 'NOT_STARTED') as ProjectStatus;
}
