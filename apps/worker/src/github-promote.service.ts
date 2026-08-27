import { PrismaClient } from '@deckgauge/db';
import { shouldSync, STATUS_COLORS } from '@deckgauge/shared';
import { createSyncAutomationRunner } from './sync-automations.js';

export interface GitHubPromoteResult {
  created: number;
  updated: number;
  markedRemoved: number;
}

/** Default state→status mapping for GitHub issues. */
const STATE_TO_LABEL: Record<string, string> = {
  open: 'In Progress',
  closed: 'Done',
};

/** Map board status label back to legacy ProjectStatus enum. */
const LABEL_TO_ENUM: Record<string, string> = {
  'not started': 'NOT_STARTED',
  'in progress': 'IN_PROGRESS',
  'at risk': 'AT_RISK',
  blocked: 'BLOCKED',
  done: 'DONE',
};

interface CachedBoardStatus {
  id: string;
  label: string;
  color: string;
}

/**
 * Minimal GitHub issue shape the promote service needs. Sourced from the
 * GitHubPort adapter's fetchIssues output (state-mode) or projectsAdapter
 * fetchProjectItems (project-mode) — fed in-memory by the processor.
 * Previously read from Postgres `github_issues`, dropped by
 * 20260603120000_drop_legacy_phase3_tables.
 */
export interface PromoteGitHubIssue {
  id: string;
  repoFullName: string;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  assigneeLogin?: string | null;
  labels: string[];
  type?: string | null;
  milestoneId?: string | null;
  projectItemId?: string | null;
  projectStatusName?: string | null;
  updatedAt: Date;
}

export interface PromoteGitHubMilestone {
  id: string;
  repoFullName: string;
  number: number;
  title: string;
  state: string;
  dueOn?: Date | null;
  updatedAt: Date;
}

export interface GitHubPromotePayload {
  issuesByRepo: Record<string, PromoteGitHubIssue[]>;
  milestonesByRepo: Record<string, PromoteGitHubMilestone[]>;
}

/** What confines a promote run. Required, because the tenant boundary rides on it. */
export interface GitHubPromoteOptions {
  /**
   * The GitHub connection this run fetched from.
   *
   * `promoteAll` used to read every `GitHubRepoSync` row in the deployment and
   * match the payload to it on `repoFullName` alone. That is `owner/repo` — a
   * key GitHub makes unique per HOST, not per Deckgauge deployment — so two
   * organizations tracking the same upstream, syncing the same public repo, or
   * reaching one private repo through two connections had one tenant's issues
   * promoted onto the other's boards (TENANCY-PROGRAMME §5a, fixed 2026-08-26).
   *
   * Required rather than optional for the same reason as Jira's: a caller that
   * forgets it must fail to compile, not silently promote across every
   * connection. `github-sync.handler.ts` already loops per instance.
   */
  instanceId: string;
}

export class GitHubPromoteService {
  private milestonesByRepo: Record<string, PromoteGitHubMilestone[]> = {};

  constructor(private readonly prisma: PrismaClient) {}

  async promoteAll(
    payload: GitHubPromotePayload = { issuesByRepo: {}, milestonesByRepo: {} },
    options: GitHubPromoteOptions,
  ): Promise<GitHubPromoteResult> {
    this.milestonesByRepo = payload.milestonesByRepo;
    let created = 0;
    let updated = 0;
    let markedRemoved = 0;
    // One runner per RUN — caches each board's rules. See sync-automations.ts.
    const automations = createSyncAutomationRunner(this.prisma);

    // New model: 1 GitHubRepoSync per (instance, repo); per-board filters live on
    // BoardGitHubSource. One repo sync fans out into N board sources.
    //
    // Confined to the connection this run fetched from — see
    // `GitHubPromoteOptions.instanceId`. Filtered in the QUERY rather than gated
    // at the create/update path, matching the Jira fix: nothing below does
    // anything for an out-of-connection row, and the unfiltered walk also ran a
    // status-cache read, an exclusion read and a project read against every other
    // tenant's boards on every sync.
    const repoSyncs = await this.prisma.gitHubRepoSync.findMany({
      where: { githubInstanceId: options.instanceId },
      include: { boardSources: true },
    });

    const { issuesByRepo } = payload;

    for (const rs of repoSyncs) {
      const repoFullName = rs.repoFullName;
      const isProjectMode = (rs as { projectNodeId?: string | null }).projectNodeId != null;

      // In-memory issues for this repo (was previously a Postgres read against
      // the now-dropped github_issues table — dropped by
      // 20260603120000_drop_legacy_phase3_tables).
      const allIssues: PromoteGitHubIssue[] = issuesByRepo[repoFullName] ?? [];

      for (const boardSource of rs.boardSources) {
        if (boardSource.syncIssuesToBoard === false) continue;

        const allowedLabels = (boardSource.allowedLabels ?? []) as string[];
        const allowedTypes = (boardSource.allowedTypes ?? []) as string[];
        const includeClosedIssues = boardSource.includeClosedIssues as boolean;
        const defaultSyncedFields = (boardSource.defaultSyncedFields as string[]) ?? [
          'name',
          'description',
          'status',
          'owner',
        ];
        const statusMapping = (boardSource.statusMapping ?? {}) as Record<string, string>;
        const noStatusBoardStatusId =
          ((boardSource as { noStatusBoardStatusId?: string | null }).noStatusBoardStatusId ?? null) as
            | string
            | null;

        const statusCache = await this.loadStatusCache(boardSource.boardId);

        // Batch-fetch existing projects scoped to THIS board (multi-board fan-out:
        // the same githubIssueId can exist on multiple boards, so we must scope
        // by boardId — not just repoFullName).
        const existingProjects = await this.prisma.project.findMany({
          where: {
            githubRepoFullName: repoFullName,
            boardId: boardSource.boardId,
          },
          select: { id: true, githubIssueId: true, status: true, statusId: true, githubSyncedFields: true, overriddenFields: true },
        });
        const projectByGithubId = new Map(existingProjects.map((p) => [p.githubIssueId, p]));

        const ghExclusions = await this.prisma.boardSyncExclusion.findMany({
          where: { boardId: boardSource.boardId, source: 'GITHUB' },
          select: { externalId: true },
        });
        const excludedGithubIds = new Set(ghExclusions.map((e) => e.externalId));

        // Per-board filtering off the shared issue set.
        let issues = allIssues;

        // Filter by state. In project-mode the GitHub Project v2 status field is the source
        // of truth for status, so we keep closed items and let resolveStatusIdFromProject map them.
        if (!includeClosedIssues && !isProjectMode) {
          issues = issues.filter((i) => i.state === 'open');
        }

        // Filter by allowedLabels (empty array = allow all)
        if (allowedLabels.length > 0) {
          issues = issues.filter((i) => {
            const issueLabelsList = i.labels as string[];
            return allowedLabels.some((al) => issueLabelsList.includes(al));
          });
        }

        // Filter by allowedTypes (empty array = allow all). AND-combined with labels.
        if (allowedTypes.length > 0) {
          issues = issues.filter((i) => {
            const issueType = (i as { type: string | null }).type;
            return issueType != null && allowedTypes.includes(issueType);
          });
        }

        // Filter board-level exclusions (rows deleted by user and recorded in BoardSyncExclusion).
        if (excludedGithubIds.size > 0) {
          issues = issues.filter((i) => !excludedGithubIds.has(i.id));
        }

        // Build milestone→group mapping when no explicit targetGroupId is set
        const milestoneGroupMap = new Map<string | null, string>();
        if (!boardSource.targetGroupId && issues.length > 0) {
          await this.buildMilestoneGroupMap(
            repoFullName,
            boardSource.boardId,
            issues,
            milestoneGroupMap,
          );
        }

        const seenIds: string[] = [];

        for (const issue of issues) {
          seenIds.push(issue.id);

          const existing = projectByGithubId.get(issue.id) ?? null;

          const issueLabels = issue.labels as string[];
          const statusId = isProjectMode
            ? await this.resolveStatusIdFromProject(
                (issue as { projectStatusName?: string | null }).projectStatusName ?? null,
                statusMapping,
                noStatusBoardStatusId,
                boardSource.boardId,
                statusCache,
              )
            : await this.resolveStatusId(
                issue.state,
                issueLabels,
                statusMapping,
                boardSource.boardId,
                statusCache,
              );
          const legacyStatus = this.toLegacyEnum(statusId, statusCache);

          // Resolve group: explicit targetGroupId, or auto-mapped from milestone
          const groupId =
            boardSource.targetGroupId ?? milestoneGroupMap.get(issue.milestoneId ?? null) ?? null;

          if (!existing) {
            const newProject = await this.prisma.project.create({
              data: {
                name: issue.title,
                description: issue.body ?? null,
                status: legacyStatus as never,
                statusId,
                owner: issue.assigneeLogin ?? '',
                assignee: issue.assigneeLogin ?? '',
                boardId: boardSource.boardId,
                groupId,
                githubIssueId: issue.id,
                githubRepoFullName: repoFullName,
                githubSyncedFields: defaultSyncedFields,
                githubRemovedFromSource: false,
              },
            });
            created++;

            await this.prisma.projectStatusChange.create({
              data: {
                projectId: newProject.id,
                fromStatus: null,
                toStatus: this.labelFromCache(statusId, statusCache) ?? legacyStatus,
                changedBy: 'sync:github',
              },
            });

            // A synced row is a new row on the board like any other.
            await automations.run({
              boardId: boardSource.boardId,
              projectId: newProject.id,
              changes: { status: legacyStatus, statusId },
            });
          } else {
            const syncedFields =
              (existing.githubSyncedFields as string[] | null) ?? defaultSyncedFields;
            const updateData: Record<string, unknown> = {
              githubRemovedFromSource: false,
            };

            const overriddenFields = (existing.overriddenFields ?? []) as string[];
            // One predicate for every field — see sync-field-registry.ts.
            const syncs = (key: string) => shouldSync({ key, overriddenFields, syncedFields });

            if (syncs('name')) {
              updateData.name = issue.title;
            }
            if (syncs('description')) {
              updateData.description = issue.body ?? null;
            }
            if (syncs('status')) {
              updateData.statusId = statusId;
              updateData.status = legacyStatus;
            }
            // Assignee is the synced-truth column with no editable counterpart,
            // so it refreshes even when Owner is overridden.
            if (syncedFields.includes('owner')) {
              updateData.assignee = issue.assigneeLogin ?? '';
            }
            if (syncs('owner')) {
              updateData.owner = issue.assigneeLogin ?? '';
            }
            // Always keep group assignment in sync with milestone
            if (!boardSource.targetGroupId) {
              updateData.groupId = groupId;
            }

            await this.prisma.project.update({
              where: { id: existing.id },
              data: updateData,
            });
            updated++;

            if (updateData.status && updateData.status !== existing.status) {
              await this.prisma.projectStatusChange.create({
                data: {
                  projectId: existing.id,
                  fromStatus:
                    this.labelFromCache(existing.statusId as string, statusCache) ??
                    (existing.status as string),
                  toStatus: this.labelFromCache(statusId, statusCache) ?? legacyStatus,
                  changedBy: 'sync:github',
                },
              });
            }

            // Full before/after pair — the rule engine decides whether anything
            // actually changed, the same decision the hand-edit path makes.
            await automations.run({
              boardId: boardSource.boardId,
              projectId: existing.id,
              changes: {
                status: updateData.status as string | undefined,
                previousStatus: existing.status as string,
                statusId: updateData.statusId as string | undefined,
                previousStatusId: existing.statusId as string | null,
              },
            });
          }
        }

        // Mark removed: projects on THIS board for THIS repo whose githubIssueId
        // is no longer in the seen list. Scoped by boardId so multi-board fan-out
        // doesn't cross-contaminate.
        const markResult = await this.prisma.project.updateMany({
          where: {
            boardId: boardSource.boardId,
            githubRepoFullName: repoFullName,
            githubIssueId: { notIn: seenIds },
            githubRemovedFromSource: false,
          },
          data: { githubRemovedFromSource: true },
        });
        markedRemoved += markResult.count;
      }
    }

    return { created, updated, markedRemoved };
  }

  /**
   * Auto-create board groups from GitHub milestones.
   * Each milestone becomes a group; issues without a milestone go to "No Milestone".
   */
  private async buildMilestoneGroupMap(
    repoFullName: string,
    boardId: string,
    issues: PromoteGitHubIssue[],
    map: Map<string | null, string>,
  ): Promise<void> {
    // Collect unique milestoneIds from issues
    const milestoneIds = [...new Set(issues.map((i) => i.milestoneId))];

    // In-memory milestones for this repo (was previously a Postgres read
    // against the now-dropped github_milestones table).
    const allRepoMilestones: PromoteGitHubMilestone[] = this.milestonesByRepo?.[repoFullName] ?? [];
    const milestoneIdSet = new Set(milestoneIds.filter(Boolean) as string[]);
    const milestones = allRepoMilestones.filter((m) => milestoneIdSet.has(m.id));
    const milestoneById = new Map(milestones.map((m) => [m.id, m]));

    // Batch-fetch all existing groups for this board (eliminates N+1 findFirst per milestone)
    const existingGroups = await this.prisma.group.findMany({
      where: { boardId },
      select: { id: true, name: true, position: true },
    });
    const groupByName = new Map(existingGroups.map((g) => [g.name, g]));
    let nextPosition = Math.max(-1, ...existingGroups.map((g) => g.position)) + 1;

    for (const msId of milestoneIds) {
      const groupName = msId ? (milestoneById.get(msId)?.title ?? msId) : 'No Milestone';

      let group = groupByName.get(groupName);

      if (!group) {
        const created = await this.prisma.group.create({
          data: {
            boardId,
            name: groupName,
            position: nextPosition++,
          },
        });
        group = { id: created.id, name: created.name, position: created.position };
        groupByName.set(groupName, group);
      }

      map.set(msId ?? null, group.id);
    }
  }

  /**
   * Resolve a GitHub Project v2 item status to a board_status ID.
   *
   * Resolution order:
   * 1. Null projectStatusName → return noStatusBoardStatusId (or first board status)
   * 2. Check projectStatusName against statusMapping (case-insensitive) → direct ID
   * 3. Check board cache by label (case-insensitive)
   * 4. Upsert a new board status using the Project's status name
   */
  private async resolveStatusIdFromProject(
    projectStatusName: string | null,
    statusMapping: Record<string, string>,
    noStatusBoardStatusId: string | null,
    boardId: string,
    cache: Map<string, CachedBoardStatus>,
  ): Promise<string> {
    if (projectStatusName == null) {
      if (noStatusBoardStatusId) return noStatusBoardStatusId;
      const first = await this.prisma.boardStatus.findFirst({
        where: { boardId },
        orderBy: { order: 'asc' },
      });
      if (first) {
        cache.set(first.label.toLowerCase(), { id: first.id, label: first.label, color: first.color });
        return first.id;
      }
      return this.upsertBoardStatus('Not Started', boardId, cache);
    }
    const mappingLower = new Map(
      Object.entries(statusMapping).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const mapped = mappingLower.get(projectStatusName.toLowerCase());
    if (mapped) {
      const resolved = this.findInCache(mapped, cache);
      if (resolved) return resolved;
    }
    const byLabel = cache.get(projectStatusName.toLowerCase());
    if (byLabel) return byLabel.id;
    return this.upsertBoardStatus(projectStatusName, boardId, cache);
  }

  /**
   * Resolve a GitHub issue state to a board_status ID.
   *
   * Resolution order:
   * 1. Check issue labels against statusMapping (case-insensitive)
   * 2. Check issue state (open/closed) against statusMapping
   * 3. Default state mapping (open → In Progress, closed → Done)
   * 4. Case-insensitive label match on the board
   * 5. Upsert a new board status
   */
  private async resolveStatusId(
    state: string,
    issueLabels: string[],
    statusMapping: Record<string, string>,
    boardId: string,
    cache: Map<string, CachedBoardStatus>,
  ): Promise<string> {
    // Build case-insensitive lookup for the status mapping
    const mappingLower = new Map(
      Object.entries(statusMapping).map(([k, v]) => [k.toLowerCase(), v]),
    );

    // 1. Check issue labels against mapping (first match wins)
    for (const label of issueLabels) {
      const mapped = mappingLower.get(label.toLowerCase());
      if (mapped) {
        const resolved = this.findInCache(mapped, cache);
        if (resolved) return resolved;
      }
    }

    // 2. Check issue state against mapping
    const stateMapped = mappingLower.get(state.toLowerCase());
    if (stateMapped) {
      const resolved = this.findInCache(stateMapped, cache);
      if (resolved) return resolved;
    }

    // 3. Default state mapping
    const defaultLabel = STATE_TO_LABEL[state] ?? state;
    const byLabel = cache.get(defaultLabel.toLowerCase());
    if (byLabel) return byLabel.id;

    // 4. Fallback: case-insensitive match on state value
    const byState = cache.get(state.toLowerCase());
    if (byState) return byState.id;

    return this.upsertBoardStatus(defaultLabel, boardId, cache);
  }

  /** Look up a mapped value in the board status cache — handles both UUID and label. */
  private findInCache(
    mappedValue: string,
    cache: Map<string, CachedBoardStatus>,
  ): string | null {
    // Direct UUID match
    for (const s of cache.values()) {
      if (s.id === mappedValue) return mappedValue;
    }
    // Label match
    const byLabel = cache.get(mappedValue.toLowerCase());
    if (byLabel) return byLabel.id;
    return null;
  }

  private async upsertBoardStatus(
    label: string,
    boardId: string,
    cache: Map<string, CachedBoardStatus>,
  ): Promise<string> {
    try {
      const color = this.pickUnusedColor(cache);
      const maxOrder = await this.prisma.boardStatus.aggregate({
        where: { boardId },
        _max: { order: true },
      });

      const created = await this.prisma.boardStatus.create({
        data: {
          boardId,
          label,
          color,
          order: (maxOrder._max.order ?? -1) + 1,
        },
      });

      cache.set(label.toLowerCase(), { id: created.id, label: created.label, color });
      return created.id;
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        const existing = await this.prisma.boardStatus.findFirst({
          where: { boardId, label: { equals: label, mode: 'insensitive' } },
        });
        if (existing) {
          cache.set(label.toLowerCase(), { id: existing.id, label: existing.label, color: '' });
          return existing.id;
        }
      }
      throw err;
    }
  }

  private pickUnusedColor(cache: Map<string, CachedBoardStatus>): string {
    const usedSet = new Set<string>();
    for (const s of cache.values()) usedSet.add(s.color);
    const available = STATUS_COLORS.filter((c) => !usedSet.has(c));
    if (available.length > 0) {
      return available[Math.floor(Math.random() * available.length)]!;
    }
    return STATUS_COLORS[Math.floor(Math.random() * STATUS_COLORS.length)]!;
  }

  private async loadStatusCache(boardId: string): Promise<Map<string, CachedBoardStatus>> {
    const statuses = await this.prisma.boardStatus.findMany({
      where: { boardId },
      select: { id: true, label: true, color: true },
    });
    const cache = new Map<string, CachedBoardStatus>();
    for (const s of statuses) {
      cache.set(s.label.toLowerCase(), { id: s.id, label: s.label, color: s.color });
    }
    return cache;
  }

  private toLegacyEnum(statusId: string, cache: Map<string, CachedBoardStatus>): string {
    for (const s of cache.values()) {
      if (s.id === statusId) {
        return LABEL_TO_ENUM[s.label.toLowerCase()] ?? 'NOT_STARTED';
      }
    }
    return 'NOT_STARTED';
  }

  /** Find the human-readable label for a board status ID by scanning the cache. */
  private labelFromCache(statusId: string, cache: Map<string, CachedBoardStatus>): string | null {
    for (const s of cache.values()) {
      if (s.id === statusId) return s.label;
    }
    return null;
  }
}
