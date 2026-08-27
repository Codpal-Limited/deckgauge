import type { PrismaClient } from '@deckgauge/db';
import { Prisma } from '@deckgauge/db';
import { CommentSchema, type Comment } from '@deckgauge/shared';
import type { UploadService } from '../uploads/upload.service.js';

interface CreateInput {
  content: Prisma.InputJsonValue;
  authorName?: string;
  uploadIds?: string[];
  /**
   * The real author, from the session — NOT from the request body. `authorName`
   * is a client-supplied display string that defaults to 'VP', so it is not an
   * identity. The column and its index already existed and were never
   * populated; this is what fills them.
   */
  authorId?: string | null;
}

interface UpdateInput {
  content?: Prisma.InputJsonValue;
  pinned?: boolean;
}

function mapToComment(raw: {
  id: string;
  projectId: string;
  content: unknown;
  authorName: string;
  authorAvatar: string | null;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}): Comment {
  return CommentSchema.parse(raw);
}

export class CommentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly uploadService?: UploadService,
  ) {}

  async listByProject(projectId: string): Promise<Comment[]> {
    const rows = await this.prisma.projectComment.findMany({
      where: { projectId },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(mapToComment);
  }

  async create(projectId: string, input: CreateInput): Promise<Comment> {
    const row = await this.prisma.projectComment.create({
      data: {
        projectId,
        content: input.content,
        authorName: input.authorName ?? 'VP',
        authorId: input.authorId ?? null,
      },
    });
    if (this.uploadService && input.uploadIds && input.uploadIds.length > 0) {
      await this.uploadService.linkToComment(row.id, input.uploadIds);
    }
    return mapToComment(row);
  }

  async update(id: string, input: UpdateInput): Promise<Comment | null> {
    const existing = await this.prisma.projectComment.findUnique({ where: { id } });
    if (!existing) return null;

    const row = await this.prisma.projectComment.update({
      where: { id },
      data: {
        ...(input.content !== undefined && { content: input.content }),
        ...(input.pinned !== undefined && { pinned: input.pinned }),
      },
    });
    return mapToComment(row);
  }

  async remove(id: string): Promise<boolean> {
    const existing = await this.prisma.projectComment.findUnique({ where: { id } });
    if (!existing) return false;
    if (this.uploadService) {
      await this.uploadService.deleteForComment(id);
    }
    await this.prisma.projectComment.delete({ where: { id } });
    return true;
  }

  async countByProject(projectIds: string[]): Promise<Record<string, number>> {
    if (projectIds.length === 0) return {};
    const groups = await this.prisma.projectComment.groupBy({
      by: ['projectId'],
      where: { projectId: { in: projectIds } },
      _count: { id: true },
    });
    const result: Record<string, number> = {};
    for (const g of groups) {
      result[g.projectId] = g._count.id;
    }
    return result;
  }
}
