import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { z } from 'zod/v4';
import {
  UpdateBoardNotificationSettingInputSchema,
  UpdateNotificationPreferencesInputSchema,
} from '@deckgauge/shared';
import { NotificationPreferenceService } from './notification-preference.service.js';
import { orgRole } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

const uuid = z.string().uuid();

/**
 * The preference routes.
 *
 * All `orgRole('VIEWER')` — a notification preference is a PERSONAL setting, not
 * an administrative one, so the floor for a tenant-scoped read is also the floor
 * for writing your own. Every query is scoped by `req.user.id`, so there is no
 * per-entity policy to declare: you can only ever read or write your own rows.
 *
 * The board routes additionally check the board belongs to the caller's
 * organization — see `boardIsInOrganization` for why that is not redundant.
 */
export async function notificationPreferenceRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new NotificationPreferenceService(prisma);

  app.get(
    '/notifications/preferences',
    { config: { policy: orgRole('VIEWER') } },
    async (req, reply) => {
      const preferences = await service.list(req.user!.id, requireOrganizationId(req));
      return reply.send({ preferences });
    },
  );

  app.put(
    '/notifications/preferences',
    { config: { policy: orgRole('VIEWER') } },
    async (req, reply) => {
      const parsed = UpdateNotificationPreferencesInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const preferences = await service.update(
        req.user!.id,
        requireOrganizationId(req),
        parsed.data.preferences,
      );
      return reply.send({ preferences });
    },
  );

  app.get<{ Params: { boardId: string } }>(
    '/boards/:boardId/notification-setting',
    { config: { policy: orgRole('VIEWER') } },
    async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) {
        return reply.code(400).send({ error: 'Invalid board ID' });
      }
      const inOrg = await service.boardIsInOrganization(
        req.params.boardId,
        requireOrganizationId(req),
      );
      // 404, not 403: another tenant's board must be indistinguishable from one
      // that does not exist.
      if (!inOrg) return reply.code(404).send({ error: 'Not found' });

      const level = await service.boardLevel(req.user!.id, req.params.boardId);
      return reply.send({ boardId: req.params.boardId, level });
    },
  );

  app.put<{ Params: { boardId: string } }>(
    '/boards/:boardId/notification-setting',
    { config: { policy: orgRole('VIEWER') } },
    async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) {
        return reply.code(400).send({ error: 'Invalid board ID' });
      }
      const parsed = UpdateBoardNotificationSettingInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

      const inOrg = await service.boardIsInOrganization(
        req.params.boardId,
        requireOrganizationId(req),
      );
      if (!inOrg) return reply.code(404).send({ error: 'Not found' });

      const level = await service.setBoardLevel(
        req.user!.id,
        req.params.boardId,
        parsed.data.level,
      );
      return reply.send({ boardId: req.params.boardId, level });
    },
  );
}
