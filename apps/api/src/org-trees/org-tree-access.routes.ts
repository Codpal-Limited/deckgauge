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
import { orgTree, AUTHENTICATED } from '../auth/policy.js';
import { notifyEntityShared } from '../notifications/triggers/entity-shared.js';

/**
 * The org-tree half of the one route family (design §5.2). Deliberately a
 * near-copy of `board-access.routes.ts`: the two differ only in the entity kind,
 * the id param name and the policy, and keeping them symmetrical is what makes a
 * divergence visible in review rather than a year later.
 *
 * `OrgTreeAccessService` is gone. `AccessService` was generalized from it
 * (design D11), so this is the original semantics plus three things it never
 * had: a Serializable transaction, a tenancy check on the grant target, and the
 * org-role ceiling.
 */
export function buildOrgTreeAccessRoutes(prisma: PrismaClient): FastifyPluginAsync {
  const access = new AccessService(prisma);

  return async (app) => {
    /**
     * The caller's own effective role and their local `User.id`.
     *
     * Both branches mirror what `orgTree(...)` enforcement does for the same
     * caller, which is the only property that matters: any disagreement shows up
     * as a control the client renders that then 403s, or a capability the caller
     * holds but cannot see — and there is no compiler signal if the two drift.
     */
    app.get<{ Params: { id: string } }>(
      '/org-trees/:id/my-role',
      { config: { policy: AUTHENTICATED } },
      async (req, reply) => {
        if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });
        // Resolved THROUGH the caller's organization: `getRole` alone carries no
        // tenant predicate, so for an org ADMIN and a foreign entity the ceiling
        // turned a null grant into OWNER (tenancy §11 precondition 7).
        const role = await access.getEffectiveRole(
          'orgTree',
          req.params.id,
          req.user.id,
          req.membership ?? null,
        );
        return reply.send({ role, userId: req.user.id });
      },
    );

    app.get<{ Params: { id: string } }>(
      '/org-trees/:id/access',
      { config: { policy: orgTree('VIEWER') } },
      async (req, reply) =>
        reply.send(
          await access.list('orgTree', req.params.id, req.membership?.organizationId ?? null),
        ),
    );

    app.post<{ Params: { id: string } }>(
      '/org-trees/:id/access',
      { config: { policy: orgTree('OWNER') } },
      async (req, reply) => {
        const parsed = GrantAccessSchema.safeParse(req.body);
        if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

        try {
          const role = await access.grant(
            'orgTree',
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
            shareKind: 'orgTree',
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
          // The tree id itself does not exist: an org ADMIN is an implicit OWNER
          // of any tree id in their organization, so this policy branch is
          // reachable with no real tree behind it. The FK on
          // `org_tree_access.org_tree_id` is what actually catches that here.
          if (isForeignKeyViolation(err)) {
            return reply.status(404).send({ error: 'Org tree not found' });
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
      '/org-trees/:id/access/:userId',
      { config: { policy: orgTree('OWNER') } },
      async (req, reply) => {
        const parsed = UpdateAccessRoleSchema.safeParse(req.body);
        if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

        try {
          // Read BEFORE the update: `updateRole` returns the new role only, and
          // without the old one "your role changed" cannot say what it changed
          // from — nor tell a real change from a re-saved unchanged form.
          const previousRole = await access.getRole(
            'orgTree',
            req.params.id,
            req.params.userId,
          );
          const role = await access.updateRole(
            'orgTree',
            req.params.id,
            req.params.userId,
            parsed.data.role,
            // Same "null only for the pre-bootstrap/break-glass caller" contract
            // as POST above.
            req.membership?.organizationId ?? null,
          );
          if (role === null) return reply.status(404).send({ error: 'Access entry not found' });

          await notifyEntityShared(prisma, req, {
            shareKind: 'orgTree',
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
      '/org-trees/:id/access/:userId',
      { config: { policy: orgTree('OWNER') } },
      async (req, reply) => {
        try {
          await access.revoke('orgTree', req.params.id, req.params.userId);
          return reply.status(204).send();
        } catch (err) {
          return mapWriteError(err, reply);
        }
      },
    );
  };
}
