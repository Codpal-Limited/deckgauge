import type { PrismaClient, Prisma } from '@deckgauge/db'
import { DEFAULT_DIGEST_WINDOW_MS, selectDigestReleases } from '@deckgauge/shared'
import { NotificationDispatcher, resolveOwnerUserId } from '@deckgauge/notifications'

/**
 * The hourly notification job: release due digests, then evaluate due-soon and
 * overdue items.
 *
 * `now` is a parameter so the job is testable without a fake clock.
 *
 * The due kinds are the ONE family that fires without a request, so they have no
 * `req.user` and are written with `actorId: null` — the actor FK is SET NULL and
 * the UI already renders an absent actor. Their wording is subject-first
 * ("Design review is overdue"), so no actor name is needed.
 */

const HOUR_MS = 60 * 60 * 1000

function digestWindowMs(): number {
  const hours = Number(process.env.DIGEST_INTERVAL_HOURS)
  // Guard the parse rather than trusting it: a typo'd env var that becomes NaN
  // would compare false against every row and silently release nothing, ever.
  return Number.isFinite(hours) && hours > 0 ? hours * HOUR_MS : DEFAULT_DIGEST_WINDOW_MS
}

export interface NotificationMaintenanceResult {
  digestsReleased: number
  dueNotified: number
}

export async function runNotificationMaintenance(
  prisma: PrismaClient,
  now: Date,
): Promise<NotificationMaintenanceResult> {
  const pending = await prisma.notification.findMany({
    where: { digestPending: true },
    select: { id: true, userId: true, organizationId: true, kind: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  const releases = selectDigestReleases(pending, now, digestWindowMs())

  for (const release of releases) {
    // The ONE write that does not go through NotificationDispatcher, and the only
    // one that should not: a summary is not a trigger. Its constituents were
    // already access-checked and preference-resolved when they were written, so
    // re-running either here would drop rows for a reader who has since lost
    // access to ONE of them and leave the rest permanently invisible — hidden as
    // pending, and never summarised.
    //
    // One transaction per user: a partial release would leave rows both hidden
    // and unsummarised, which is invisible to the reader forever.
    await prisma.$transaction(async (tx) => {
      const summary = await tx.notification.create({
        data: {
          organizationId: release.organizationId,
          userId: release.userId,
          // No actor: a digest is written by the system, not by a person.
          actorId: null,
          kind: 'DIGEST',
          // Cast, not a widened type on DigestPayload itself: an index signature
          // there would let any key through and lose the two the panel reads.
          payload: release.payload as unknown as Prisma.InputJsonValue,
        },
      })
      await tx.notification.updateMany({
        where: { id: { in: release.memberIds } },
        data: { digestPending: false, digestId: summary.id },
      })
    })
  }

  const dueNotified = await evaluateDueDates(prisma, now)
  return { digestsReleased: releases.length, dueNotified }
}

const DUE_SOON_WINDOW_MS = 24 * HOUR_MS

/**
 * Due-soon and overdue for items with a resolvable owner.
 *
 * Two rules keep an HOURLY job from nagging:
 *   - dedup by (kind, projectId, userId) — at most one of each, ever;
 *   - moving a due date into the future CLEARS the stale OVERDUE row, so a
 *     rescheduled item can legitimately notify again later.
 *
 * Goes through the same `NotificationDispatcher` as every request-driven trigger,
 * which is why it lives in a shared package: the reverse access check and the
 * preference rules must not have a second implementation here.
 */
async function evaluateDueDates(prisma: PrismaClient, now: Date): Promise<number> {
  const horizon = new Date(now.getTime() + DUE_SOON_WINDOW_MS)

  // A due date pushed back into the future retires its OVERDUE row, so the item
  // can notify again if it slips a second time. Runs BEFORE the dedup counts
  // below read the table, or a just-cleared row would still suppress the notice.
  await prisma.notification.deleteMany({
    where: { kind: 'ITEM_OVERDUE', project: { dueDate: { gt: now } } },
  })

  const candidates = await prisma.project.findMany({
    where: { dueDate: { not: null, lte: horizon }, boardId: { not: null } },
    select: {
      id: true,
      owner: true,
      ownerId: true,
      dueDate: true,
      board: { select: { id: true, organizationId: true } },
    },
  })

  const dispatcher = new NotificationDispatcher(prisma)
  let notified = 0

  for (const project of candidates) {
    const board = project.board
    if (!board?.organizationId || !project.dueDate) continue

    const ownerId = await resolveOwnerUserId(prisma, {
      boardId: board.id,
      organizationId: board.organizationId,
      ownerLabel: project.owner,
      ownerId: project.ownerId,
    })
    if (!ownerId) continue

    const kind = project.dueDate < now ? 'ITEM_OVERDUE' : 'ITEM_DUE_SOON'

    const already = await prisma.notification.count({
      where: { kind, projectId: project.id, userId: ownerId },
    })
    if (already > 0) continue

    notified += await dispatcher.dispatch({
      kind,
      organizationId: board.organizationId,
      actorId: null,
      recipientIds: [ownerId],
      subject: { kind: 'project', id: project.id, boardId: board.id },
      payload: { dueDate: project.dueDate.toISOString() },
    })
  }

  return notified
}
