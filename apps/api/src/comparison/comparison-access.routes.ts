import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { GrantAccessSchema, UpdateAccessRoleSchema } from '@deckgauge/shared';
import { AccessService } from '../access/access.service.js';
import {
  RoleExceedsOrgRoleError,
  TargetNotInOrganizationError,
} from '../access/last-owner.error.js';
import {
  isForeignKeyViolation,
  isUniqueViolation,
  isWriteConflict,
  mapWriteError,
} from '../access/prisma-errors.js';
import { comparison, AUTHENTICATED } from '../auth/policy.js';
import { notifyEntityShared } from '../notifications/triggers/entity-shared.js';

/**
 * The comparison half of the one route family (design §5.2) — the fifth and
 * last, and a near-copy of the other four. There is no implicit-ownership rule
 * here (comparisons have no parent entity), so `my-role` is the plain form.
 */
export function buildComparisonAccessRoutes(prisma: PrismaClient): FastifyPluginAsync {
  const access = new AccessService(prisma);

  return async (app) => {
    app.get<{ Params: { id: string } }>(
      '/comparisons/:id/my-role',
      { config: { policy: AUTHENTICATED } },
      async (req, reply) => {
        if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });
        // Resolved THROUGH the caller's organization: `getRole` alone carries no
        // tenant predicate, so for an org ADMIN and a foreign entity the ceiling
        // turned a null grant into OWNER (tenancy §11 precondition 7).
        const role = await access.getEffectiveRole(
          'comparison',
          req.params.id,
          req.user.id,
          req.membership ?? null,
        );
        return reply.send({ role, userId: req.user.id });
      },
    );

    app.get<{ Params: { id: string } }>(
      '/comparisons/:id/access',
      { config: { policy: comparison('VIEWER') } },
      async (req, reply) =>
        reply.send(
          await access.list('comparison', req.params.id, req.membership?.organizationId ?? null),
        ),
    );

    app.post<{ Params: { id: string } }>(
      '/comparisons/:id/access',
      { config: { policy: comparison('OWNER') } },
      async (req, reply) => {
        const parsed = GrantAccessSchema.safeParse(req.body);
        if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

        try {
          const role = await access.grant(
            'comparison',
            req.params.id,
            parsed.data.userId,
            parsed.data.role,
            // Null only where the policy layer deliberately admits a caller with
            // no membership — the pre-bootstrap admin (design D9).
            req.membership?.organizationId ?? null,
          );

          // POST is always a NEW grant — `grant` inserts, and an existing row
          // surfaces as 409 ALREADY_HAS_ACCESS — so previousRole is null by
          // construction and no extra read is needed to tell the two kinds apart.
          await notifyEntityShared(prisma, req, {
            shareKind: 'comparison',
            entityId: req.params.id,
            granteeId: parsed.data.userId,
            role,
            previousRole: null,
          });
          return reply.status(201).send({ userId: parsed.data.userId, role });
        } catch (err) {
          if (err instanceof TargetNotInOrganizationError) {
            return reply.status(404).send({ error: 'User not found' });
          }
          if (err instanceof RoleExceedsOrgRoleError) {
            return reply.status(409).send({ error: 'ROLE_EXCEEDS_ORG_ROLE' });
          }
          // An org ADMIN is an implicit OWNER of any comparison id in their
          // organization, so this branch is reachable with no real comparison
          // behind it. The FK on `comparison_access` catches that.
          if (isForeignKeyViolation(err)) {
            return reply.status(404).send({ error: 'Comparison not found' });
          }
          if (isUniqueViolation(err)) {
            return reply.status(409).send({ error: 'ALREADY_HAS_ACCESS' });
          }
          if (isWriteConflict(err)) {
            return reply.status(409).send({ error: 'CONCURRENT_UPDATE' });
          }
          throw err;
        }
      },
    );

    app.patch<{ Params: { id: string; userId: string } }>(
      '/comparisons/:id/access/:userId',
      { config: { policy: comparison('OWNER') } },
      async (req, reply) => {
        const parsed = UpdateAccessRoleSchema.safeParse(req.body);
        if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

        try {
          // Read BEFORE the update: `updateRole` returns the new role only, and
          // without the old one "your role changed" cannot say what it changed
          // from — nor tell a real change from a re-saved unchanged form.
          const previousRole = await access.getRole(
            'comparison',
            req.params.id,
            req.params.userId,
          );
          const role = await access.updateRole(
            'comparison',
            req.params.id,
            req.params.userId,
            parsed.data.role,
            req.membership?.organizationId ?? null,
          );
          if (role === null) return reply.status(404).send({ error: 'Access entry not found' });

          await notifyEntityShared(prisma, req, {
            shareKind: 'comparison',
            entityId: req.params.id,
            granteeId: req.params.userId,
            role,
            previousRole: previousRole,
          });
          return reply.send({ userId: req.params.userId, role });
        } catch (err) {
          return mapWriteError(err, reply);
        }
      },
    );

    app.delete<{ Params: { id: string; userId: string } }>(
      '/comparisons/:id/access/:userId',
      { config: { policy: comparison('OWNER') } },
      async (req, reply) => {
        try {
          await access.revoke('comparison', req.params.id, req.params.userId);
          return reply.status(204).send();
        } catch (err) {
          return mapWriteError(err, reply);
        }
      },
    );
  };
}
