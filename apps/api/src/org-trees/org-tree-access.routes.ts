import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { GrantOrgTreeAccessSchema, UpdateOrgTreeAccessSchema } from '@deckgauge/shared';
import { orgTree } from '../auth/policy.js';
import { OrgTreeAccessService, LastOwnerError } from './org-tree-access.service.js';

export function buildOrgTreeAccessRoutes(prisma: PrismaClient): FastifyPluginAsync {
  const service = new OrgTreeAccessService(prisma);

  return async (app) => {
    app.get<{ Params: { id: string } }>(
      '/org-trees/:id/access',
      { config: { policy: orgTree('VIEWER') } },
      async (req, reply) => reply.send(await service.list(req.params.id)),
    );

    app.post<{ Params: { id: string } }>(
      '/org-trees/:id/access',
      { config: { policy: orgTree('OWNER') } },
      async (req, reply) => {
        const body = GrantOrgTreeAccessSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

        // Mirrors board-access.routes.ts's POST handler: verify the target
        // user exists before writing, rather than letting a bad userId reach
        // the FK constraint on OrgTreeAccess.userId and surface as a 500.
        const targetUser = await prisma.user.findUnique({ where: { id: body.data.userId } });
        if (!targetUser) return reply.code(404).send({ error: 'User not found' });

        const row = await service.grant(req.params.id, body.data.userId, body.data.role);
        return reply.code(201).send(row);
      },
    );

    app.patch<{ Params: { id: string; userId: string } }>(
      '/org-trees/:id/access/:userId',
      { config: { policy: orgTree('OWNER') } },
      async (req, reply) => {
        const body = UpdateOrgTreeAccessSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        try {
          const updated = await service.updateRole(req.params.id, req.params.userId, body.data.role);
          if (!updated) return reply.code(404).send({ error: 'Access entry not found' });
          return reply.send(updated);
        } catch (err) {
          if (err instanceof LastOwnerError) return reply.code(409).send({ error: err.message });
          throw err;
        }
      },
    );

    app.delete<{ Params: { id: string; userId: string } }>(
      '/org-trees/:id/access/:userId',
      { config: { policy: orgTree('OWNER') } },
      async (req, reply) => {
        try {
          await service.revoke(req.params.id, req.params.userId);
          return reply.code(204).send();
        } catch (err) {
          if (err instanceof LastOwnerError) return reply.code(409).send({ error: err.message });
          throw err;
        }
      },
    );
  };
}
