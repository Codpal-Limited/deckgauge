import type { PrismaClient, BoardAccessRole } from '@deckgauge/db';
import type { FastifyRequest, FastifyReply } from 'fastify';

const ROLE_RANK: Record<BoardAccessRole, number> = {
  VIEWER: 0,
  EDITOR: 1,
  OWNER: 2,
};

export async function hasBoardAccess(
  db: PrismaClient,
  userId: string,
  boardId: string,
  minRole: BoardAccessRole,
): Promise<boolean> {
  const access = await db.boardAccess.findUnique({
    where: { boardId_userId: { boardId, userId } },
  });
  return !!access && ROLE_RANK[access.role] >= ROLE_RANK[minRole];
}

export function requireBoardAccess(db: PrismaClient, minRole: BoardAccessRole) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) return reply.code(401).send({ error: 'Unauthorized' });
    const { boardId } = request.params as { boardId: string };
    if (!(await hasBoardAccess(db, request.user.id, boardId, minRole))) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  };
}
