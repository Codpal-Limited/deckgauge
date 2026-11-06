// Board ↔ Bitbucket repo attachments. Mirrors board-gitlab-source.service.ts
// for attach (tenant + ownership resolved through the sync's instance, refusal
// is CrossOrganizationSyncError → 404) and board-github-source.service.ts for
// the bulk path ("select all in project").
//
// Two deliberate tightenings over the GitLab original:
//   - update/detach resolve the source WITHIN the board named in the route.
//     GitLab's act on the bare id, so board A's EDITOR could detach board B's
//     source by naming its id under /boards/A/…;
//   - a target group must belong to the board it is used on.
//
// No issue / PR row toggles: Bitbucket feeds intelligence only (spec non-goals).
import type { PrismaClient } from '@deckgauge/db';
import { CrossOrganizationSyncError } from './cross-organization-sync-error.js';
import { visibleConnectionWhere, type ConnectionCaller } from '../connections/connection-visibility.js';
import { assertRepoInWorkspace } from '../project-syncs/bitbucket-repo-sync.service.js';

// The sync's code-sync state + watermarks, for the board Sources card.
const BITBUCKET_SYNC_INCLUDE = {
  bitbucketRepoSync: {
    select: {
      id: true,
      repoFullName: true,
      projectKey: true,
      bitbucketInstanceId: true,
      syncPrs: true,
      syncCommits: true,
      syncDeployments: true,
      lastSyncedAt: true,
      lastDeploymentSyncAt: true,
    },
  },
} as const;

/** The target group is not on this board. Routes answer 400. */
export class BitbucketTargetGroupError extends Error {
  constructor(groupId: string) {
    super(`Group ${groupId} is not on this board`);
    this.name = 'BitbucketTargetGroupError';
  }
}

async function assertGroupOnBoard(prisma: PrismaClient, boardId: string, groupId: string | null | undefined) {
  if (!groupId) return;
  const group = await prisma.group.findFirst({ where: { id: groupId, boardId }, select: { id: true } });
  if (!group) throw new BitbucketTargetGroupError(groupId);
}

export class BoardBitbucketSourceService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(boardId: string) {
    return this.prisma.boardBitbucketSource.findMany({
      where: { boardId },
      include: BITBUCKET_SYNC_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  /** `caller` first — see BoardJiraSourceService.attach for the full rule. */
  async attach(
    caller: ConnectionCaller,
    input: { boardId: string; bitbucketRepoSyncId: string; targetGroupId?: string | null },
  ) {
    const sync = await this.prisma.bitbucketRepoSync.findFirst({
      where: {
        id: input.bitbucketRepoSyncId,
        bitbucketInstance: { organizationId: caller.organizationId, ...visibleConnectionWhere(caller) },
      },
      select: { id: true },
    });
    if (!sync) throw new CrossOrganizationSyncError('bitbucket', input.bitbucketRepoSyncId);
    await assertGroupOnBoard(this.prisma, input.boardId, input.targetGroupId);

    return this.prisma.boardBitbucketSource.create({
      data: {
        boardId: input.boardId,
        bitbucketRepoSyncId: sync.id,
        targetGroupId: input.targetGroupId ?? null,
      },
      include: BITBUCKET_SYNC_INCLUDE,
    });
  }

  /** Null when `id` is not a source of `boardId`. */
  async update(boardId: string, id: string, patch: { targetGroupId?: string | null }) {
    const existing = await this.prisma.boardBitbucketSource.findFirst({ where: { id, boardId }, select: { id: true } });
    if (!existing) return null;
    await assertGroupOnBoard(this.prisma, boardId, patch.targetGroupId);
    return this.prisma.boardBitbucketSource.update({
      where: { id },
      data: patch,
      include: BITBUCKET_SYNC_INCLUDE,
    });
  }

  /** False when `id` is not a source of `boardId`. The repo sync itself stays. */
  async detach(boardId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.boardBitbucketSource.deleteMany({ where: { id, boardId } });
    return count > 0;
  }
}

export interface BitbucketBulkBindArgs {
  prisma: PrismaClient;
  /** The instance must be in the caller's organization AND usable by them. */
  caller: ConnectionCaller;
  boardId: string;
  instanceId: string;
  repos: Array<{ fullName: string; projectKey?: string | null }>;
  targetGroupId?: string | null;
}

export interface BitbucketBulkBindResult {
  /** Repos newly attached to this board. */
  addedCount: number;
  /** Repos that were already attached to this board. */
  skippedCount: number;
}

/**
 * The bulk attach path. `instanceId` comes off the request body and this
 * UPSERTS BitbucketRepoSync rows onto it — enrolling repos for ingestion under
 * that instance's stored token — so it is resolved through the caller before
 * anything is written (same reasoning as GitHub's bulkBind). Every repo is
 * checked against the workspace up front, so a bad batch writes nothing.
 *
 * New syncs default every code flag ON; an existing sync keeps its flags and
 * only gains a project key it lacked. Nothing is enqueued: the next scheduled
 * run (or POST /boards/:boardId/sync) picks the repos up.
 */
export async function bulkBindBitbucket(args: BitbucketBulkBindArgs): Promise<BitbucketBulkBindResult> {
  const instance = await args.prisma.bitbucketInstance.findFirst({
    where: { id: args.instanceId, organizationId: args.caller.organizationId, ...visibleConnectionWhere(args.caller) },
    select: { id: true, workspace: true },
  });
  if (!instance) throw new CrossOrganizationSyncError('bitbucket', args.instanceId);
  for (const repo of args.repos) assertRepoInWorkspace(repo.fullName, instance.workspace);
  await assertGroupOnBoard(args.prisma, args.boardId, args.targetGroupId);

  let addedCount = 0;
  let skippedCount = 0;
  for (const repo of args.repos) {
    const projectKey = repo.projectKey ?? null;
    const sync = await args.prisma.bitbucketRepoSync.upsert({
      where: { bitbucketInstanceId_repoFullName: { bitbucketInstanceId: instance.id, repoFullName: repo.fullName } },
      update: projectKey ? { projectKey } : {},
      create: {
        bitbucketInstanceId: instance.id,
        repoFullName: repo.fullName,
        projectKey,
        syncPrs: true,
        syncCommits: true,
        syncDeployments: true,
      },
      select: { id: true },
    });

    const attached = await args.prisma.boardBitbucketSource.findUnique({
      where: { boardId_bitbucketRepoSyncId: { boardId: args.boardId, bitbucketRepoSyncId: sync.id } },
      select: { id: true },
    });
    if (attached) {
      skippedCount += 1;
      continue;
    }
    await args.prisma.boardBitbucketSource.create({
      data: { boardId: args.boardId, bitbucketRepoSyncId: sync.id, targetGroupId: args.targetGroupId ?? null },
    });
    addedCount += 1;
  }
  return { addedCount, skippedCount };
}
