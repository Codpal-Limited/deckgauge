import type { PrismaClient } from '@deckgauge/db';
import { NotificationDispatcher } from '../notification-dispatcher.js';

/**
 * "You were added to a workspace."
 *
 * Fired on ACTIVATION, not on the invite itself — which is the only point where
 * there is anybody to notify. `MembershipService.invite` creates a PENDING row
 * keyed by EMAIL with no user bound: the invitee may have no account at all, and
 * a tenant-scoped notification filed against a non-member would land in a
 * workspace they cannot open. `resolveForUser` binds that row to a User and flips
 * it to ACTIVE on their first login, and that is where this runs.
 *
 * The actor is the INVITER (`invitedByUserId`), not the person logging in.
 * Crediting the caller would make the dispatcher's actor-drop rule swallow the
 * row — you would be notified about your own login — and "Dana added you to
 * Acme" is the message anyway. A null inviter is fine: the FK is SET NULL and
 * the UI already renders an absent actor.
 *
 * Every query it needs is inside its own try/catch: this runs on an
 * authentication path, where a thrown error would cost someone their login.
 */

export interface InviteCaller {
  log?: { error: (err: unknown, msg?: string) => void };
}

export interface OrgMemberInvitedInput {
  /** The membership that was just bound and activated. */
  membershipId: string;
}

export async function notifyOrgMemberInvited(
  prisma: PrismaClient,
  caller: InviteCaller,
  input: OrgMemberInvitedInput,
): Promise<void> {
  try {
    const membership = await prisma.orgMembership.findUnique({
      where: { id: input.membershipId },
      select: {
        organizationId: true,
        userId: true,
        role: true,
        status: true,
        invitedByUserId: true,
      },
    });
    // Not ACTIVE, or no account bound, means nobody to notify — and nobody who
    // could open the workspace the row would be filed under.
    if (!membership?.userId || membership.status !== 'ACTIVE') return;

    await new NotificationDispatcher(prisma).dispatch({
      kind: 'ORG_MEMBER_INVITED',
      organizationId: membership.organizationId,
      actorId: membership.invitedByUserId,
      recipientIds: [membership.userId],
      subject: { kind: 'none' },
      payload: { role: membership.role },
    });
  } catch (err) {
    caller.log?.error(err, 'notifications: invite trigger failed — the login is unaffected');
  }
}
