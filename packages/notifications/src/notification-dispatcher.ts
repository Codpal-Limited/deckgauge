import type { PrismaClient, Prisma } from '@deckgauge/db';
import type {
  BoardNotificationLevel,
  NotificationKindValue,
  NotificationMode,
} from '@deckgauge/shared';
import { notifiableOnBoard, notifiableOnEntity, notifiableOnOrgTree } from './notifiable.js';
import { resolveDelivery } from './preference-resolution.js';
import type { NotificationSubject } from './notification-subject.js';

/**
 * The ONE place a TRIGGER writes a notification row.
 *
 * The single exception is the digest release job in
 * `apps/worker/src/notification-maintenance.handler.ts`, which writes the summary
 * row directly — deliberately, because a summary is not a trigger and its
 * constituents were already filtered when they were written. Nothing else may
 * call `prisma.notification.create`.
 *
 * Five steps, same order, every time:
 *   1. dedupe recipients
 *   2. drop the actor — nobody is notified about their own action
 *   3. the REVERSE access check
 *   4. board level, then per-kind mode
 *   5. createMany
 *
 * Step 3 lives here rather than in each trigger on purpose: it is what stops a
 * private employee comment or a personal board leaking through a NEW trigger
 * whose author forgot to ask, and `notifiable.ts` is already the single home of
 * that rule.
 */

export interface DispatchInput {
  kind: NotificationKindValue;
  organizationId: string;
  /** Null for the date-driven kinds — they fire from the worker, with no request. */
  actorId: string | null;
  recipientIds: readonly string[];
  subject: NotificationSubject;
  /** Kind-specific extras only. Never labels or hrefs. */
  payload?: Record<string, unknown>;
}

export class NotificationDispatcher {
  constructor(private readonly prisma: PrismaClient) {}

  async dispatch(input: DispatchInput): Promise<number> {
    const candidates = [...new Set(input.recipientIds)].filter(
      (id) => id.length > 0 && id !== input.actorId,
    );
    if (candidates.length === 0) return 0;

    const reachable = await this.reachable(input, candidates);
    if (reachable.size === 0) return 0;

    const boardId = this.boardIdOf(input.subject);
    const recipients = [...reachable];
    const [preferences, boardSettings] = await Promise.all([
      this.prisma.notificationPreference.findMany({
        where: {
          userId: { in: recipients },
          organizationId: input.organizationId,
          kind: input.kind,
        },
        select: { userId: true, mode: true },
      }),
      boardId
        ? this.prisma.boardNotificationSetting.findMany({
            where: { userId: { in: recipients }, boardId },
            select: { userId: true, level: true },
          })
        : Promise.resolve([]),
    ]);

    const modeOf = new Map(preferences.map((p) => [p.userId, p.mode as NotificationMode]));
    const levelOf = new Map(boardSettings.map((s) => [s.userId, s.level as BoardNotificationLevel]));

    const rows: Prisma.NotificationCreateManyInput[] = [];
    for (const userId of recipients) {
      const delivery = resolveDelivery({
        kind: input.kind,
        kindMode: modeOf.get(userId) ?? null,
        boardLevel: levelOf.get(userId) ?? null,
      });
      if (delivery === 'DROP') continue;

      rows.push({
        organizationId: input.organizationId,
        userId,
        actorId: input.actorId,
        kind: input.kind,
        digestPending: delivery === 'DIGEST',
        ...(input.payload ? { payload: input.payload as Prisma.InputJsonValue } : {}),
        ...this.subjectColumns(input.subject),
      });
    }
    if (rows.length === 0) return 0;

    const { count } = await this.prisma.notification.createMany({ data: rows });
    return count;
  }

  /** Which candidates can actually reach the subject. One query set, not one per row. */
  private async reachable(input: DispatchInput, candidates: string[]): Promise<Set<string>> {
    const { subject, organizationId } = input;
    switch (subject.kind) {
      case 'projectComment':
      case 'project':
        return notifiableOnBoard(this.prisma, subject.boardId, organizationId, candidates);
      case 'orgEmployeeComment':
        return notifiableOnOrgTree(this.prisma, subject.orgTreeId, organizationId, candidates);
      case 'share':
        return notifiableOnEntity(
          this.prisma,
          subject.shareKind,
          subject.entityId,
          organizationId,
          candidates,
        );
      case 'none': {
        // No entity to check — so the ORGANIZATION is the boundary, and an active
        // membership is what admits. Never an unchecked pass-through.
        const memberships = await this.prisma.orgMembership.findMany({
          where: { organizationId, status: 'ACTIVE', userId: { in: candidates } },
          select: { userId: true },
        });
        return new Set(memberships.flatMap((m) => (m.userId ? [m.userId] : [])));
      }
    }
  }

  /** The board a per-board setting would apply to, when the subject has one. */
  private boardIdOf(subject: NotificationSubject): string | null {
    if (subject.kind === 'projectComment' || subject.kind === 'project') return subject.boardId;
    if (subject.kind === 'share' && subject.shareKind === 'board') return subject.entityId;
    return null;
  }

  private subjectColumns(subject: NotificationSubject) {
    switch (subject.kind) {
      case 'projectComment':
        return { projectCommentId: subject.id };
      case 'orgEmployeeComment':
        return { orgEmployeeCommentId: subject.id };
      case 'project':
        return { projectId: subject.id };
      case 'share':
        return { shareKind: subject.shareKind, shareEntityId: subject.entityId };
      case 'none':
        return {};
    }
  }
}
