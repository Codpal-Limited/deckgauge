import type { PrismaClient } from '@deckgauge/db';
import { Prisma } from '@deckgauge/db';
import { EmployeeCommentSchema, type EmployeeComment } from '@deckgauge/shared';
import type { UploadService } from '../uploads/upload.service.js';

interface CreateInput {
  content: Prisma.InputJsonValue;
  authorName?: string;
  /**
   * The real author, from the session — never from the body. Same reasoning as
   * ProjectComment: `authorName` is a client-supplied display string defaulting
   * to 'VP', so it is not an identity.
   */
  authorId?: string | null;
  /** Author-only visibility (design D2). Opt-in; defaults to public. */
  isPrivate?: boolean;
  uploadIds?: string[];
}
interface UpdateInput {
  content?: Prisma.InputJsonValue;
  pinned?: boolean;
  isPrivate?: boolean;
}

/**
 * `update` refuses an `isPrivate` change from a non-author with a value the route
 * can turn into a 403, rather than a silent no-op: the caller has to be able to
 * learn why nothing happened.
 */
export type UpdateResult = EmployeeComment | null | 'forbidden';

function mapToComment(raw: unknown): EmployeeComment {
  return EmployeeCommentSchema.parse(raw);
}

export class EmployeeCommentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly uploadService?: UploadService,
  ) {}

  /**
   * What `callerId` may read about this employee.
   *
   * `callerId` is REQUIRED and may be null — required so the compiler enumerates
   * every reader rather than letting one silently keep the old leaky behaviour,
   * and nullable because single-user mode bypasses every policy and never
   * populates a user.
   *
   * A null caller matches no author, so private comments are INVISIBLE rather
   * than universal. Failing closed is the only safe reading: the alternative is
   * that turning on a documented convenience mode publishes every private note.
   */
  private visibleTo(callerId: string | null) {
    return callerId
      ? { OR: [{ isPrivate: false }, { authorId: callerId }] }
      : { isPrivate: false };
  }

  async listByEmployee(
    orgEmployeeId: string,
    callerId: string | null,
  ): Promise<EmployeeComment[]> {
    const rows = await this.prisma.orgEmployeeComment.findMany({
      where: { orgEmployeeId, ...this.visibleTo(callerId) },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(mapToComment);
  }

  async create(orgEmployeeId: string, input: CreateInput): Promise<EmployeeComment> {
    const row = await this.prisma.orgEmployeeComment.create({
      data: {
        orgEmployeeId,
        content: input.content,
        authorName: input.authorName ?? 'VP',
        authorId: input.authorId ?? null,
        isPrivate: input.isPrivate ?? false,
      },
    });
    if (this.uploadService && input.uploadIds && input.uploadIds.length > 0) {
      await this.uploadService.linkToEmployeeComment(row.id, input.uploadIds);
    }
    return mapToComment(row);
  }

  /**
   * `callerId` gates the PRIVACY FLAG only, not the edit itself: an EDITOR may
   * still change a comment's text under today's rule. Revealing someone else's
   * private note is a different power from editing a shared one, so the flag is
   * gated on authorship rather than on the comment's edit permission.
   */
  async update(
    id: string,
    input: UpdateInput,
    callerId: string | null,
  ): Promise<UpdateResult> {
    const existing = await this.prisma.orgEmployeeComment.findUnique({ where: { id } });
    if (!existing) return null;
    if (input.isPrivate !== undefined && existing.authorId !== callerId) return 'forbidden';
    const row = await this.prisma.orgEmployeeComment.update({
      where: { id },
      data: {
        ...(input.content !== undefined && { content: input.content }),
        ...(input.pinned !== undefined && { pinned: input.pinned }),
        ...(input.isPrivate !== undefined && { isPrivate: input.isPrivate }),
      },
    });
    return mapToComment(row);
  }

  async remove(id: string): Promise<boolean> {
    const existing = await this.prisma.orgEmployeeComment.findUnique({ where: { id } });
    if (!existing) return false;
    if (this.uploadService) await this.uploadService.deleteForEmployeeComment(id);
    await this.prisma.orgEmployeeComment.delete({ where: { id } });
    return true;
  }

  /**
   * Counts what THIS caller may actually read (design D4). A count that included
   * unreadable comments would say 3 while the list shows 1 — which both looks
   * broken and tells the viewer a private note exists. "Private comments exist"
   * is itself information, and a badge is not the place to leak it.
   */
  async countByEmployee(
    ids: string[],
    callerId: string | null,
  ): Promise<Record<string, number>> {
    if (ids.length === 0) return {};
    const groups = await this.prisma.orgEmployeeComment.groupBy({
      by: ['orgEmployeeId'],
      where: { orgEmployeeId: { in: ids }, ...this.visibleTo(callerId) },
      _count: { id: true },
    });
    const result: Record<string, number> = {};
    for (const g of groups) result[g.orgEmployeeId] = g._count.id;
    return result;
  }
}
