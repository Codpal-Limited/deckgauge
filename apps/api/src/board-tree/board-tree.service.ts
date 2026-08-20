import type { PrismaClient, BoardFolder, UserBoardPref, UserRoadmapPref } from '@deckgauge/db';
import {
  CreateBoardFolderInputSchema,
  UpdateBoardFolderInputSchema,
  UpdateBoardPrefInputSchema,
  type CreateBoardFolderInput,
  type UpdateBoardFolderInput,
  type UpdateBoardPrefInput,
} from '@deckgauge/shared';

export class BoardTreeService {
  constructor(private readonly prisma: PrismaClient) {}

  async getTree(
    userId: string,
  ): Promise<{
    folders: BoardFolder[];
    prefs: UserBoardPref[];
    roadmaps: { id: string; name: string }[];
    roadmapPrefs: UserRoadmapPref[];
  }> {
    const [folders, prefs, roadmaps, roadmapPrefs] = await Promise.all([
      this.prisma.boardFolder.findMany({
        where: { userId },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.userBoardPref.findMany({ where: { userId } }),
      this.prisma.roadmap.findMany({
        where: { accessEntries: { some: { userId } } },
        select: { id: true, name: true },
      }),
      this.prisma.userRoadmapPref.findMany({ where: { userId } }),
    ]);
    return { folders, prefs, roadmaps, roadmapPrefs };
  }

  private async nextSiblingPosition(
    userId: string,
    parentId: string | null,
  ): Promise<number> {
    const last = await this.prisma.boardFolder.findFirst({
      where: { userId, parentId },
      orderBy: { position: 'desc' },
    });
    return last ? last.position + 1 : 0;
  }

  async createFolder(
    organizationId: string,
    userId: string,
    input: CreateBoardFolderInput,
  ): Promise<BoardFolder> {
    const data = CreateBoardFolderInputSchema.parse(input);
    const parentId = data.parentId ?? null;

    if (parentId != null) {
      const parent = await this.prisma.boardFolder.findFirst({
        where: { id: parentId, userId },
      });
      if (!parent) throw new Error('Parent folder not found');
    }

    const position =
      data.position ?? (await this.nextSiblingPosition(userId, parentId));

    return this.prisma.boardFolder.create({
      data: { organizationId, userId, name: data.name, color: data.color, parentId, position },
    });
  }

  async updateFolder(
    userId: string,
    id: string,
    input: UpdateBoardFolderInput,
  ): Promise<BoardFolder | null> {
    const data = UpdateBoardFolderInputSchema.parse(input);

    const existing = await this.prisma.boardFolder.findFirst({
      where: { id, userId },
    });
    if (!existing) return null;

    if (data.parentId != null) {
      const parent = await this.prisma.boardFolder.findFirst({
        where: { id: data.parentId, userId },
      });
      if (!parent) throw new Error('Parent folder not found');
    }

    return this.prisma.boardFolder.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.color !== undefined && { color: data.color }),
        ...(data.parentId !== undefined && { parentId: data.parentId }),
        ...(data.position !== undefined && { position: data.position }),
        ...(data.isExpanded !== undefined && { isExpanded: data.isExpanded }),
      },
    });
  }

  async deleteFolder(userId: string, id: string): Promise<boolean> {
    const existing = await this.prisma.boardFolder.findFirst({
      where: { id, userId },
    });
    if (!existing) return false;

    // onDelete: Cascade removes child folders; onDelete: SetNull un-files boards.
    await this.prisma.boardFolder.delete({ where: { id } });
    return true;
  }

  async upsertPref(
    userId: string,
    boardId: string,
    input: UpdateBoardPrefInput,
  ): Promise<UserBoardPref> {
    const data = UpdateBoardPrefInputSchema.parse(input);
    const patch = {
      ...(data.folderId !== undefined && { folderId: data.folderId }),
      ...(data.position !== undefined && { position: data.position }),
      ...(data.isFavorite !== undefined && { isFavorite: data.isFavorite }),
      ...(data.isHidden !== undefined && { isHidden: data.isHidden }),
    };
    return this.prisma.userBoardPref.upsert({
      where: { userId_boardId: { userId, boardId } },
      create: { userId, boardId, ...patch },
      update: patch,
    });
  }
}
