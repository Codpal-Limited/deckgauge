import type { PrismaClient } from '@deckgauge/db';
import { NotificationService } from './notification.service.js';
import type { NotificationCommentSubject } from './notification-subject.js';
import { extractMentionIds, newMentionIds } from './mention-parse.js';

/**
 * The one place a comment write turns into notifications.
 *
 * Four route handlers need this (project comment create/update, employee comment
 * create/update) and they must not each grow their own copy of the actor rule,
 * the diff rule, and the swallow rule.
 *
 * Called from the ROUTE, not from the comment service, for one reason: the actor
 * is `req.user`, and the service does not have the request. `authorName` in the
 * body is a client-supplied display string that defaults to 'VP' — a
 * notification sourced from it would be spoofable by anyone who can post a
 * comment.
 *
 * EVERY query this feature adds to a write path lives in here, behind the
 * try/catch. That is deliberate: an earlier version resolved the comment's
 * parent in the route instead, and a failing lookup turned a successfully-saved
 * comment into a 500. The user's content is the thing they care about; a lost
 * notification is an annoyance.
 */

export type CommentKind = 'projectComment' | 'orgEmployeeComment';

/** The subset of the request this needs — keeps it testable without Fastify. */
export interface MentionHookCaller {
  user?: { id: string } | null;
  membership?: { organizationId: string } | null;
  log?: { error: (err: unknown, msg?: string) => void };
}

export interface MentionHookInput {
  kind: CommentKind;
  commentId: string;
  /** The stored content AFTER the write. */
  after: unknown;
  /**
   * The content BEFORE an edit, for the added-only diff (design D5). Omit on
   * create — where every mention is new. `null` is a legitimate stored value, so
   * absence is signalled by the key being missing, not by a null.
   */
  before?: unknown;
}

/**
 * The pre-edit content, for the diff. Read BEFORE the update, so it cannot come
 * from the hook itself.
 *
 * `null` on any failure — and the caller must then skip notifying entirely
 * rather than fall back to create semantics, which would notify everyone named
 * in the comment on a routine typo fix.
 */
export async function readPreviousCommentContent(
  prisma: PrismaClient,
  kind: CommentKind,
  commentId: string,
  log?: { error: (err: unknown, msg?: string) => void },
): Promise<{ content: unknown } | null> {
  try {
    const row =
      kind === 'projectComment'
        ? await prisma.projectComment.findUnique({
            where: { id: commentId },
            select: { content: true },
          })
        : await prisma.orgEmployeeComment.findUnique({
            where: { id: commentId },
            select: { content: true },
          });
    return row ? { content: row.content } : null;
  } catch (err) {
    log?.error(err, 'notifications: could not read the pre-edit comment content — skipping mentions');
    return null;
  }
}

/** Resolves the entity a mention on this comment is scoped to. */
async function resolveSubject(
  prisma: PrismaClient,
  kind: CommentKind,
  commentId: string,
): Promise<NotificationCommentSubject | null> {
  if (kind === 'projectComment') {
    const row = await prisma.projectComment.findUnique({
      where: { id: commentId },
      select: { project: { select: { boardId: true } } },
    });
    // `Project.boardId` is nullable — a project can outlive its board, and then
    // there is nothing to check access against.
    const boardId = row?.project?.boardId;
    return boardId ? { kind, id: commentId, boardId } : null;
  }

  const row = await prisma.orgEmployeeComment.findUnique({
    where: { id: commentId },
    select: { employee: { select: { orgTreeId: true } } },
  });
  const orgTreeId = row?.employee?.orgTreeId;
  return orgTreeId ? { kind, id: commentId, orgTreeId } : null;
}

/**
 * Never throws and never reports failure: the caller has already committed the
 * comment. Failures are logged, never silent.
 */
export async function notifyCommentMentions(
  prisma: PrismaClient,
  caller: MentionHookCaller,
  input: MentionHookInput,
): Promise<void> {
  try {
    // No resolved user means no actor to credit; no membership means no tenant
    // to file it under (organization_id is NOT NULL, by design). Single-user mode
    // hits both — it bypasses every policy and never populates either.
    const actorId = caller.user?.id ?? null;
    const organizationId = caller.membership?.organizationId ?? null;
    if (!actorId || !organizationId) return;

    const mentionIds =
      'before' in input
        ? newMentionIds(input.before, input.after)
        : extractMentionIds(input.after);
    if (mentionIds.length === 0) return;

    // Resolved only once there is somebody to notify — no query for the common
    // case of a comment with no mentions.
    const subject = await resolveSubject(prisma, input.kind, input.commentId);
    if (!subject) return;

    await new NotificationService(prisma).notifyMentions({
      organizationId,
      actorId,
      mentionIds,
      subject,
    });
  } catch (err) {
    caller.log?.error(err, 'notifications: failed to record comment mentions — comment is unaffected');
  }
}
