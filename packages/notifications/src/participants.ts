import type { PrismaClient } from '@deckgauge/db';
import { resolveOwnerUserId } from './owner-identity.js';

/**
 * Who is "involved" in an item: its owner, plus everyone who has commented on
 * it.
 *
 * This is Jira's watcher set DERIVED FROM PARTICIPATION rather than stored in a
 * subscription table. A table would need a UI to manage, and an unmaintained
 * subscription table notifies nobody — participation is a signal people generate
 * simply by working.
 */

export interface ItemParticipantsInput {
  projectId: string;
  boardId: string;
  organizationId: string;
}

export interface ItemParticipants {
  /** Null when the owner label matches no unique account (see owner-identity). */
  ownerId: string | null;
  /** Owner plus commenters, deduped. The dispatcher still access-filters these. */
  participantIds: string[];
}

export async function itemParticipants(
  prisma: PrismaClient,
  input: ItemParticipantsInput,
): Promise<ItemParticipants> {
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { owner: true, ownerId: true },
  });
  if (!project) return { ownerId: null, participantIds: [] };

  const [ownerId, comments] = await Promise.all([
    resolveOwnerUserId(prisma, {
      boardId: input.boardId,
      organizationId: input.organizationId,
      ownerLabel: project.owner,
      ownerId: project.ownerId,
    }),
    // `authorId` was an indexed column written NOWHERE until mentions shipped, so
    // older comments legitimately have none. They contribute no participant.
    prisma.projectComment.findMany({
      where: { projectId: input.projectId, authorId: { not: null } },
      select: { authorId: true },
      distinct: ['authorId'],
    }),
  ]);

  const participantIds = [
    ...new Set([
      ...(ownerId ? [ownerId] : []),
      ...comments.flatMap((c) => (c.authorId ? [c.authorId] : [])),
    ]),
  ];

  return { ownerId, participantIds };
}
