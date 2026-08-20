import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { z } from 'zod';
import { ComparisonMembersService } from './comparison-members.service.js';
import { ComparisonService } from './comparison.service.js';
import { AUTHENTICATED, comparison, ORG_MEMBER } from '../auth/policy.js';
import { BoardAccessDeniedError } from '../auth/board-access.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

function requireUser(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = req.user?.id;
  if (!userId) {
    reply.status(401).send({ error: 'Auth required' });
    return null;
  }
  return userId;
}

export const CreateComparisonSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const RenameComparisonSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const SetComparisonMembersSchema = z.object({
  boardIds: z.array(z.string().min(1)).max(12),
});

// Routes for standalone Comparison entities — reached through the Comparisons
// category, not a board tab. Each comparison is owned by its creator; the
// comparison widgets read its member set (comparison_members) and fan the
// single-board builders out across it.
export async function comparisonRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
): Promise<void> {
  const comparisons = new ComparisonService(prisma);
  const members = new ComparisonMembersService(prisma);

  // GET /api/comparisons — the current user's comparisons.
  app.get('/comparisons', { config: { policy: AUTHENTICATED } }, async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return reply.send(await comparisons.listForUser(userId, req.membership ?? null));
  });

  // POST /api/comparisons — create a comparison.
  app.post('/comparisons', { config: { policy: ORG_MEMBER } }, async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const parsed = CreateComparisonSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const created = await comparisons.create(requireOrganizationId(req), userId, parsed.data.name);
    return reply.status(201).send(created);
  });

  // GET /api/comparisons/:id
  app.get<{ Params: { id: string } }>('/comparisons/:id', { config: { policy: comparison('VIEWER') } }, async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    // No access predicate here: `comparison('VIEWER')` already decided. `null`
    // means the id names nothing, which is a 404 either way.
    const found = await comparisons.getById(req.params.id);
    if (!found) return reply.status(404).send({ error: 'Not found' });
    return reply.send(found);
  });

  // PATCH /api/comparisons/:id — rename.
  app.patch<{ Params: { id: string } }>('/comparisons/:id', { config: { policy: comparison('EDITOR') } }, async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const parsed = RenameComparisonSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const ok = await comparisons.rename(req.params.id, parsed.data.name);
    if (!ok) return reply.status(404).send({ error: 'Not found' });
    return reply.send(await comparisons.getById(req.params.id));
  });

  // DELETE /api/comparisons/:id
  app.delete<{ Params: { id: string } }>('/comparisons/:id', { config: { policy: comparison('OWNER') } }, async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const ok = await comparisons.delete(req.params.id);
    if (!ok) return reply.status(404).send({ error: 'Not found' });
    return reply.status(204).send();
  });

  // GET /api/comparisons/:id/members
  app.get<{ Params: { id: string } }>('/comparisons/:id/members', { config: { policy: comparison('VIEWER') } }, async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    if (!(await comparisons.exists(req.params.id))) {
      return reply.status(404).send({ error: 'Not found' });
    }
    // `members.list` still filters the member boards per caller — design D16.
    // Holding the comparison says nothing about the boards inside it.
    const list = await members.list(req.params.id, userId, req.log, req.membership ?? null);
    return reply.send({ members: list });
  });

  // PUT /api/comparisons/:id/members — replace the full ordered board set.
  app.put<{ Params: { id: string } }>('/comparisons/:id/members', { config: { policy: comparison('EDITOR') } }, async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    if (!(await comparisons.exists(req.params.id))) {
      return reply.status(404).send({ error: 'Not found' });
    }
    const parsed = SetComparisonMembersSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    try {
      await members.replace(
        req.params.id,
        parsed.data.boardIds,
        userId,
        req.log,
        req.membership ?? null,
      );
    } catch (err) {
      // Holding the comparison says nothing about the boards named in the body
      // (design D16) — refuse the whole request, naming what was rejected.
      if (err instanceof BoardAccessDeniedError) {
        return reply.status(403).send({ error: err.message, boardIds: err.boardIds });
      }
      throw err;
    }
    const list = await members.list(req.params.id, userId, req.log, req.membership ?? null);
    return reply.send({ members: list });
  });
}
