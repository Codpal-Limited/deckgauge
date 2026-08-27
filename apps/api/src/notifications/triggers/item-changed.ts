import type { PrismaClient } from '@deckgauge/db';
import { NotificationDispatcher } from '../notification-dispatcher.js';
import { itemParticipants } from '../participants.js';
import { resolveOwnerUserId } from '../owner-identity.js';

/**
 * The three item-update triggers, in one hook because they share one route and
 * one before/after pair.
 *
 * Called from the ROUTE, never the service: the actor is `req.user`, and a
 * trigger inside the service would fire for every sync-written row too.
 *
 * Never throws — the caller has already committed the update.
 */

export interface ItemChangeCaller {
  user?: { id: string } | null;
  membership?: { organizationId: string } | null;
  log?: { error: (err: unknown, msg?: string) => void };
}

export interface ItemSnapshot {
  owner: string;
  ownerId: string | null;
  status: string;
  dueDate: Date | null;
}

export interface ItemChangedInput {
  projectId: string;
  boardId: string;
  before: ItemSnapshot;
  after: ItemSnapshot;
}

function sameDate(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

export async function notifyItemChanged(
  prisma: PrismaClient,
  caller: ItemChangeCaller,
  input: ItemChangedInput,
): Promise<void> {
  try {
    const actorId = caller.user?.id ?? null;
    const organizationId = caller.membership?.organizationId ?? null;
    if (!actorId || !organizationId) return;

    const ownerChanged = input.before.owner !== input.after.owner;
    const statusChanged = input.before.status !== input.after.status;
    const dueChanged = !sameDate(input.before.dueDate, input.after.dueDate);
    if (!ownerChanged && !statusChanged && !dueChanged) return;

    const dispatcher = new NotificationDispatcher(prisma);
    const subject = { kind: 'project' as const, id: input.projectId, boardId: input.boardId };

    if (ownerChanged) {
      const newOwnerId = await resolveOwnerUserId(prisma, {
        boardId: input.boardId,
        organizationId,
        ownerLabel: input.after.owner,
        ownerId: input.after.ownerId,
      });
      if (newOwnerId) {
        await dispatcher.dispatch({
          kind: 'ITEM_ASSIGNED',
          organizationId,
          actorId,
          recipientIds: [newOwnerId],
          subject,
        });
      }
    }

    if (!statusChanged && !dueChanged) return;

    // Resolved once and shared: both remaining kinds go to the same audience.
    const { participantIds } = await itemParticipants(prisma, {
      projectId: input.projectId,
      boardId: input.boardId,
      organizationId,
    });
    if (participantIds.length === 0) return;

    if (statusChanged) {
      await dispatcher.dispatch({
        kind: 'ITEM_STATUS_CHANGED',
        organizationId,
        actorId,
        recipientIds: participantIds,
        subject,
        payload: { from: input.before.status, to: input.after.status },
      });
    }

    if (dueChanged) {
      await dispatcher.dispatch({
        kind: 'ITEM_DUE_DATE_CHANGED',
        organizationId,
        actorId,
        recipientIds: participantIds,
        subject,
        payload: {
          from: input.before.dueDate?.toISOString() ?? null,
          to: input.after.dueDate?.toISOString() ?? null,
        },
      });
    }
  } catch (err) {
    caller.log?.error(err, 'notifications: item-changed trigger failed — the item is unaffected');
  }
}
