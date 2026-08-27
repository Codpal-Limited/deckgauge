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
import { roadmap, AUTHENTICATED } from '../auth/policy.js';
import { notifyEntityShared } from '../notifications/triggers/entity-shared.js';

/**
 * The roadmap half of the one route family, normalized (design D17).
 *
 * What it replaces: `PUT /roadmaps/:id/access`, which the spec describes as a
 * bulk-replace but which was actually a single-row `upsert` — `RoadmapService.
 * setAccess`. The spec's stated defect (a bulk replace racing two owners into
 * discarding each other's change) therefore did not apply. The REAL defect was
 * worse and simpler: **`setAccess` had no last-owner check at all.**
 * `revokeAccess` guarded removal; nothing guarded demotion. So
 * `PUT { userId: <the only owner>, role: 'VIEWER' }` silently left a roadmap
 * with no owner — nobody who could share it, restore an owner, or delete it.
 * That is §1.3 defect 2, live on roadmaps until this file.
 *
 * `AccessService` guards demotion as well as revocation (design D11), inside a
 * Serializable transaction, so the same request now answers `409 LAST_OWNER`.
 */
export function buildRoadmapAccessRoutes(prisma: PrismaClient): FastifyPluginAsync {
  const access = new AccessService(prisma);

  return async (app) => {
    app.get<{ Params: { id: string } }>(
      '/roadmaps/:id/my-role',
      { config: { policy: AUTHENTICATED } },
      async (req, reply) => {
        if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });
        // Resolved THROUGH the caller's organization: `getRole` alone carries no
        // tenant predicate, so for an org ADMIN and a foreign entity the ceiling
        // turned a null grant into OWNER (tenancy §11 precondition 7).
        const role = await access.getEffectiveRole(
          'roadmap',
          req.params.id,
          req.user.id,
          req.membership ?? null,
        );
        return reply.send({ role, userId: req.user.id });
      },
    );

    /**
     * VIEWER, not OWNER as before: design D6 makes the dialog readable by anyone
     * with access, and §5.2 specifies VIEWER for every entity's list. This is a
     * deliberate LOOSENING and the only one in this route family — a roadmap
     * viewer can now see who else it is shared with, which is the same thing a
     * board viewer has been able to do since phase A.
     */
    app.get<{ Params: { id: string } }>(
      '/roadmaps/:id/access',
      { config: { policy: roadmap('VIEWER') } },
      async (req, reply) =>
        reply.send(
          await access.list('roadmap', req.params.id, req.membership?.organizationId ?? null),
        ),
    );

    app.post<{ Params: { id: string } }>(
      '/roadmaps/:id/access',
      { config: { policy: roadmap('OWNER') } },
      async (req, reply) => {
        const parsed = GrantAccessSchema.safeParse(req.body);
        if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

        try {
          const role = await access.grant(
            'roadmap',
            req.params.id,
            parsed.data.userId,
            parsed.data.role,
            req.membership?.organizationId ?? null,
          );

          // POST is always a NEW grant — `grant` inserts, and an existing row
          // surfaces as 409 ALREADY_HAS_ACCESS — so previousRole is null by
          // construction and no extra read is needed to tell the two kinds apart.
          await notifyEntityShared(prisma, req, {
            shareKind: 'roadmap',
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
          if (isForeignKeyViolation(err)) {
            return reply.status(404).send({ error: 'Roadmap not found' });
          }
          // The behaviour change PUT could not express: granting to someone who
          // already has access is a distinct answer from changing their role.
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
      '/roadmaps/:id/access/:userId',
      { config: { policy: roadmap('OWNER') } },
      async (req, reply) => {
        const parsed = UpdateAccessRoleSchema.safeParse(req.body);
        if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

        try {
          // Read BEFORE the update: `updateRole` returns the new role only, and
          // without the old one "your role changed" cannot say what it changed
          // from — nor tell a real change from a re-saved unchanged form.
          const previousRole = await access.getRole(
            'roadmap',
            req.params.id,
            req.params.userId,
          );
          const role = await access.updateRole(
            'roadmap',
            req.params.id,
            req.params.userId,
            parsed.data.role,
            req.membership?.organizationId ?? null,
          );
          if (role === null) return reply.status(404).send({ error: 'Access entry not found' });

          await notifyEntityShared(prisma, req, {
            shareKind: 'roadmap',
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
      '/roadmaps/:id/access/:userId',
      { config: { policy: roadmap('OWNER') } },
      async (req, reply) => {
        try {
          await access.revoke('roadmap', req.params.id, req.params.userId);
          return reply.status(204).send();
        } catch (err) {
          return mapWriteError(err, reply);
        }
      },
    );
  };
}
