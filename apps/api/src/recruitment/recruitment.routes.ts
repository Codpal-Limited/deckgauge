import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { z } from 'zod';
import { RecruitmentService, RecruitmentError } from './recruitment.service.js';
import { board } from '../auth/policy.js';

const OnboardBodySchema = z.object({
  orgTreeId: z.string().min(1),
  managerId: z.string().nullish(),
});

/** Requires the caller to have at least EDITOR access on the board. */
async function requireBoardEditor(
  req: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
  boardId: string,
): Promise<boolean> {
  const userId = req.user?.id;
  if (!userId) {
    reply.status(401).send({ error: 'Auth required' });
    return false;
  }
  const access = await prisma.boardAccess.findUnique({
    where: { boardId_userId: { boardId, userId } },
  });
  if (!access || access.role === 'VIEWER') {
    reply.status(403).send({ error: 'Forbidden' });
    return false;
  }
  return true;
}

const STATUS_BY_CODE: Record<RecruitmentError['code'], number> = {
  NOT_FOUND: 404,
  NOT_RECRUITMENT: 400,
  ALREADY_ONBOARDED: 409,
};

export async function recruitmentRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new RecruitmentService(prisma);

  // POST /boards/:boardId/candidates/:projectId/onboard — create an OrgEmployee from a
  // Hired candidate row and link the row to it. EDITOR+ on the board required.
  app.post<{ Params: { boardId: string; projectId: string } }>(
    '/boards/:boardId/candidates/:projectId/onboard',
    { config: { policy: board('EDITOR') } },
    async (req, reply) => {
      const { boardId, projectId } = req.params;
      if (!(await requireBoardEditor(req, reply, prisma, boardId))) return;

      const parsed = OnboardBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      try {
        const result = await service.onboardCandidate(projectId, parsed.data.orgTreeId, {
          managerId: parsed.data.managerId ?? null,
        });
        return reply.status(201).send(result);
      } catch (err) {
        if (err instanceof RecruitmentError) {
          return reply.status(STATUS_BY_CODE[err.code]).send({ error: err.message, code: err.code });
        }
        throw err;
      }
    },
  );
}
