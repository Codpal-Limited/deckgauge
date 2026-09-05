import type { PrismaClient } from '@deckgauge/db';

/**
 * Turn an item's owner LABEL into a real user id, or null.
 *
 * `Project.owner` is a display string, not a relation — so "notify the person
 * this was assigned to" has to bridge a string to an account. Two sources, in
 * order of trust:
 *
 *   1. `BoardOwner.userId`, when someone has explicitly linked the label.
 *   2. A unique match on name or email among ACTIVE members of the organization.
 *
 * Rule 2 is UNIQUE-MATCH-ONLY. Two people called "Dana Levi" resolve to null and
 * nobody is notified, because notifying the wrong colleague about someone else's
 * work is worse than notifying nobody.
 */

/** `project.service.ts` writes this when an item has no owner. Never a person. */
const PLACEHOLDER_LABELS = new Set(['', 'unassigned']);

/**
 * Three is enough to know the answer is "ambiguous" without reading a whole
 * organization into memory.
 */
const AMBIGUITY_PROBE_LIMIT = 3;

export interface ResolveOwnerInput {
  boardId: string;
  organizationId: string;
  /** The stored `Project.owner` / `Project.assignee` string. */
  ownerLabel: string | null;
  /** `Project.ownerId` — a BoardOwner id, NOT a user id. */
  ownerId: string | null;
}

export async function resolveOwnerUserId(
  prisma: PrismaClient,
  input: ResolveOwnerInput,
): Promise<string | null> {
  if (input.ownerId) {
    // Scoped to the board: `BoardOwner` is unique per (boardId, name), so an id
    // from another board is stale data, not an identity.
    const owner = await prisma.boardOwner.findFirst({
      where: { id: input.ownerId, boardId: input.boardId },
      select: { userId: true },
    });
    if (owner?.userId) return owner.userId;
  }

  const label = input.ownerLabel?.trim() ?? '';
  if (PLACEHOLDER_LABELS.has(label.toLowerCase())) return null;

  // Memberships, not users: an account that left the organization must not stay
  // notifiable, and this is the same "membership is what admits" rule as
  // `notifiable.ts`.
  const matches = await prisma.orgMembership.findMany({
    where: {
      organizationId: input.organizationId,
      status: 'ACTIVE',
      userId: { not: null },
      user: {
        is: {
          OR: [
            { name: { equals: label, mode: 'insensitive' } },
            { email: { equals: label, mode: 'insensitive' } },
          ],
        },
      },
    },
    select: { userId: true },
    take: AMBIGUITY_PROBE_LIMIT,
  });

  const unique = [...new Set(matches.map((m) => m.userId).filter((id): id is string => !!id))];
  return unique.length === 1 ? unique[0]! : null;
}
