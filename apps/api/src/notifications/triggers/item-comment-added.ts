import type { PrismaClient } from '@deckgauge/db';
import { NotificationDispatcher } from '../notification-dispatcher.js';
import { itemParticipants } from '../participants.js';
import { extractMentionIds } from '../mention-parse.js';

/**
 * "Someone commented on an item you're involved in."
 *
 * Runs AFTER the mention hook on the same write, and subtracts whoever that hook
 * already notified: being told twice about one comment reads as a bug, and the
 * mention is the more specific of the two messages.
 */

export interface CommentAddedCaller {
  user?: { id: string } | null;
  membership?: { organizationId: string } | null;
  log?: { error: (err: unknown, msg?: string) => void };
}

export interface CommentAddedInput {
  commentId: string;
  projectId: string;
  /** The STORED body — the same source of truth the mention hook reads. */
  content: unknown;
}

export async function notifyItemCommentAdded(
  prisma: PrismaClient,
  caller: CommentAddedCaller,
  input: CommentAddedInput,
): Promise<void> {
  try {
    const actorId = caller.user?.id ?? null;
    const organizationId = caller.membership?.organizationId ?? null;
    if (!actorId || !organizationId) return;

    // Resolved HERE, not in the route: every query this needs has to sit behind
    // this try/catch, or an unguarded lookup turns a saved comment into a 500 —
    // the precedent the mention hook was written to set.
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { boardId: true },
    });
    // No board means no way to ask who may see this, so nobody is notified.
    if (!project?.boardId) return;
    const boardId = project.boardId;

    const { participantIds } = await itemParticipants(prisma, {
      projectId: input.projectId,
      boardId,
      organizationId,
    });
    if (participantIds.length === 0) return;

    const mentioned = new Set(extractMentionIds(input.content));
    const recipients = participantIds.filter((id) => !mentioned.has(id));
    if (recipients.length === 0) return;

    await new NotificationDispatcher(prisma).dispatch({
      kind: 'ITEM_COMMENT_ADDED',
      organizationId,
      actorId,
      recipientIds: recipients,
      // The COMMENT, not the item: the href must land on what was written.
      subject: { kind: 'projectComment', id: input.commentId, boardId },
    });
  } catch (err) {
    caller.log?.error(
      err,
      'notifications: comment-added trigger failed — the comment is unaffected',
    );
  }
}
