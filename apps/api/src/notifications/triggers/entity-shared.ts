import type { PrismaClient } from '@deckgauge/db';
import type { AccessEntityKind, AccessRoleValue } from '@deckgauge/shared';
import { NotificationDispatcher } from '../notification-dispatcher.js';

/**
 * "X shared a board with you" and "X changed your role on it".
 *
 * One hook for all five shareable kinds, because `AccessService.grant` is one
 * implementation for all five — the trigger mirrors the abstraction rather than
 * being copied into five route files.
 */

export interface SharedCaller {
  user?: { id: string } | null;
  membership?: { organizationId: string } | null;
  log?: { error: (err: unknown, msg?: string) => void };
}

export interface EntitySharedInput {
  shareKind: AccessEntityKind;
  entityId: string;
  granteeId: string;
  role: AccessRoleValue;
  /** The role before this call, or null when there was no grant. */
  previousRole: AccessRoleValue | null;
}

export async function notifyEntityShared(
  prisma: PrismaClient,
  caller: SharedCaller,
  input: EntitySharedInput,
): Promise<void> {
  try {
    const actorId = caller.user?.id ?? null;
    const organizationId = caller.membership?.organizationId ?? null;
    if (!actorId || !organizationId) return;

    // Re-granting the role someone already holds is a no-op the UI can produce by
    // saving an unchanged form. Nothing happened, so nothing is announced.
    if (input.previousRole === input.role) return;

    const isNewGrant = input.previousRole === null;

    await new NotificationDispatcher(prisma).dispatch({
      kind: isNewGrant ? 'ENTITY_SHARED' : 'ACCESS_ROLE_CHANGED',
      organizationId,
      actorId,
      recipientIds: [input.granteeId],
      subject: { kind: 'share', shareKind: input.shareKind, entityId: input.entityId },
      payload: isNewGrant
        ? { role: input.role }
        : { role: input.role, previousRole: input.previousRole },
    });
  } catch (err) {
    caller.log?.error(err, 'notifications: share trigger failed — the grant is unaffected');
  }
}
