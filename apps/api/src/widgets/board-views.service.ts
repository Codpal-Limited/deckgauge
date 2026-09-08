import type { PrismaClient } from '@deckgauge/db';
import { z } from 'zod';

export const CreateBoardViewSchema = z.object({
  // Comparisons are no longer board views — they are a standalone entity
  // (see comparison.routes). Boards create BOARD, DASHBOARD and FOCUS views.
  type: z.enum(['BOARD', 'DASHBOARD', 'FOCUS']),
  name: z.string().min(1).max(100),
});

export const UpdateBoardViewSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  position: z.number().int().min(0).optional(),
});

export type CreateBoardViewInput = z.infer<typeof CreateBoardViewSchema>;
export type UpdateBoardViewInput = z.infer<typeof UpdateBoardViewSchema>;

export class BoardViewService {
  constructor(private readonly prisma: PrismaClient) {}

  async listByBoard(boardId: string) {
    return this.prisma.boardView.findMany({
      where: { boardId },
      orderBy: { position: 'asc' },
    });
  }

  async create(boardId: string, input: CreateBoardViewInput) {
    const validated = CreateBoardViewSchema.parse(input);
    const count = await this.prisma.boardView.count({ where: { boardId } });
    return this.prisma.boardView.create({
      data: {
        boardId,
        type: validated.type,
        name: validated.name,
        position: count,
      },
    });
  }

  async update(id: string, input: UpdateBoardViewInput) {
    const validated = UpdateBoardViewSchema.parse(input);
    return this.prisma.boardView.update({
      where: { id },
      data: validated,
    });
  }

  async delete(id: string): Promise<boolean> {
    const view = await this.prisma.boardView.findUnique({ where: { id } });
    if (!view) return false;
    if (view.type === 'BOARD') {
      const boardViewCount = await this.prisma.boardView.count({
        where: { boardId: view.boardId, type: 'BOARD' },
      });
      if (boardViewCount <= 1) {
        throw new Error('Cannot delete the last board view');
      }
    }
    await this.prisma.boardView.delete({ where: { id } });
    return true;
  }
}
