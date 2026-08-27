import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { z } from 'zod/v4';
import { NotificationService } from './notification.service.js';
import { orgRole } from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

const uuid = z.string().uuid();

/**
 * The bell's four routes.
 *
 * All `orgRole('VIEWER')` — the floor for a tenant-scoped read, and what makes
 * `requireOrganizationId` safe here: the policy guarantees a membership, so the
 * handler never has to guess which organization the caller is looking at. The
 * per-entity check is NOT here; it happens inside `list`, because what a
 * notification points at can become unreachable after the row was written.
 */
export async function notificationRoutes(
  app: FastifyInstance,
  { prisma }: { prisma: PrismaClient },
) {
  const service = new NotificationService(prisma);

  /** The caller's own role in their active organization, for the read filter. */
  const roleOf = (req: { membership: { role: string } | null }) =>
    (req.membership?.role ?? 'VIEWER') as 'ADMIN' | 'MEMBER' | 'VIEWER';

  app.get<{ Querystring: { unreadOnly?: string } }>(
    '/notifications',
    { config: { policy: orgRole('VIEWER') } },
    async (req, reply) => {
      const result = await service.list(
        req.user!.id,
        requireOrganizationId(req),
        roleOf(req),
        { unreadOnly: req.query.unreadOnly === 'true', log: req.log },
      );
      return reply.send(result);
    },
  );

  /**
   * Deliberately unfiltered and therefore cheap — the bell polls it, while the
   * list is fetched only when the menu opens. See the design's §5 note: the
   * badge is a hint, the list is the truth, and opening the menu reconciles them.
   */
  app.get(
    '/notifications/unread-count',
    { config: { policy: orgRole('VIEWER') } },
    async (req, reply) => {
      const count = await service.unreadCount(req.user!.id, requireOrganizationId(req));
      return reply.send({ count });
    },
  );

  /**
   * `read-all` is registered BEFORE `:id/read` so the literal path is not
   * swallowed by the param route.
   */
  app.post(
    '/notifications/read-all',
    { config: { policy: orgRole('VIEWER') } },
    async (req, reply) => {
      const count = await service.markAllRead(req.user!.id, requireOrganizationId(req));
      return reply.send({ marked: count });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/notifications/:id/read',
    { config: { policy: orgRole('VIEWER') } },
    async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) {
        return reply.code(400).send({ error: 'Invalid notification ID' });
      }
      const ok = await service.markRead(
        req.params.id,
        req.user!.id,
        requireOrganizationId(req),
      );
      // 404 rather than 403: another user's notification must be
      // indistinguishable from one that does not exist.
      if (!ok) return reply.code(404).send({ error: 'Not found' });
      return reply.code(204).send();
    },
  );
}
