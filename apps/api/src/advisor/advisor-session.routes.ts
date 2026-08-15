// EI Advisor — board-scoped, per-user conversation storage. Board access is
// enforced twice on the way in — the declared `board('VIEWER')` policy (the
// one the boot assertion in policy.plugin.ts requires of every route, and the
// one actually checked by `buildPolicyPlugin`'s preHandler) plus the
// pre-existing `requireBoardAccess` middleware, kept for the same
// defense-in-depth reason `intelligence-query/routes.ts` keeps it alongside
// its own `board(...)` declarations. Ownership is enforced a THIRD time inside
// the service (`AdvisorSessionService`, "every method takes userId and
// boardId and filters on both"), which is what makes another user's session
// id indistinguishable from a non-existent one (404, never 403) — VIEWER is
// enough at the board-role layer precisely because that per-user filter sits
// underneath it.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { advisorAppendMessageSchema } from '@deckgauge/shared';
import { requireBoardAccess } from '../board-access/board-access.middleware.js';
import { board } from '../auth/policy.js';
import { AdvisorSessionService } from './advisor-session.service.js';

interface BoardParams {
  boardId: string;
}

interface SessionParams extends BoardParams {
  sessionId: string;
}

/** `requireBoardAccess` has already rejected an unauthenticated request. */
function callerId(req: FastifyRequest): string {
  return (req as FastifyRequest & { user: { id: string } }).user.id;
}

export function advisorSessionRoutes({ prisma }: { prisma: PrismaClient }) {
  return async function (app: FastifyInstance) {
    const sessions = new AdvisorSessionService(prisma);
    const guard = {
      config: { policy: board('VIEWER') },
      preHandler: [requireBoardAccess(prisma, 'VIEWER')],
    };

    app.get<{ Params: BoardParams }>(
      '/boards/:boardId/advisor/sessions',
      guard,
      async (req, reply) => {
        const list = await sessions.list(callerId(req), req.params.boardId);
        return reply.send({ sessions: list });
      },
    );

    app.post<{ Params: BoardParams }>(
      '/boards/:boardId/advisor/sessions',
      guard,
      async (req, reply) => {
        const created = await sessions.create(callerId(req), req.params.boardId);
        return reply.code(201).send(created);
      },
    );

    app.get<{ Params: SessionParams }>(
      '/boards/:boardId/advisor/sessions/:sessionId',
      guard,
      async (req, reply) => {
        const transcript = await sessions.get(
          callerId(req),
          req.params.boardId,
          req.params.sessionId,
        );
        if (!transcript) return reply.code(404).send({ error: 'session_not_found' });
        return reply.send(transcript);
      },
    );

    app.post<{ Params: SessionParams }>(
      '/boards/:boardId/advisor/sessions/:sessionId/messages',
      guard,
      async (req, reply) => {
        const parsed = advisorAppendMessageSchema.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid_message' });

        const appended = await sessions.appendMessage(
          callerId(req),
          req.params.boardId,
          req.params.sessionId,
          parsed.data,
        );
        if (!appended) return reply.code(404).send({ error: 'session_not_found' });
        return reply.code(204).send();
      },
    );

    app.delete<{ Params: SessionParams }>(
      '/boards/:boardId/advisor/sessions/:sessionId',
      guard,
      async (req, reply) => {
        const removed = await sessions.remove(
          callerId(req),
          req.params.boardId,
          req.params.sessionId,
        );
        if (!removed) return reply.code(404).send({ error: 'session_not_found' });
        return reply.code(204).send();
      },
    );
  };
}
