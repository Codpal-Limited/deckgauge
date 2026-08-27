import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DeveloperProfileLinkSchema } from '@deckgauge/shared';
import { DeveloperProfileService } from './developer-profile.service.js';
import type { PrismaClient } from '@deckgauge/db';
import { ORG_ADMIN } from '../auth/policy.js';
import { mapWriteError } from '../access/prisma-errors.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

/**
 * The developer-identity mapping surface.
 *
 * Both routes were `AUTHENTICATED`. That is not a level below the right one, it
 * is the absence of a decision: `authenticated` resolves no membership, so any
 * caller holding a token — no organization, no role — could read every profile
 * in the deployment (login, display name, EMAIL and the local-user link) and
 * rewrite any of those links. The mapping decides who each PR, commit and
 * review is attributed to, so it drives per-developer analytics, the org-tree
 * ranking and the employee-board activity signals.
 *
 * `ORG_ADMIN`, matching the `ADMIN` docstring's own description of what it is
 * for — "global settings with no per-entity owner". `orgRole` also establishes
 * membership FIRST, which `admin` (a bare `isAdmin` read) does not, and the
 * write below needs an organization to check its target against.
 *
 * That residual is now CLOSED. `DeveloperProfile` carries `organizationId` and
 * is unique per `(organizationId, provider, login)`
 * (20260826000400_developer_profile_tenant_key), so both handlers below pass
 * `requireOrganizationId(req)` into the service and the ROW is scoped as well
 * as the caller. The three gates are distinct and none substitutes for another:
 * the POLICY says "you administer some organization", the TENANT predicate says
 * "and this profile is one of yours", the MEMBERSHIP check says "and the user
 * you named is in it". `e9344edd` fixed only the first — a policy cannot narrow
 * a row, which is the recurring confusion in this programme.
 */
export function developerProfileRoutes(deps: { prisma: PrismaClient }) {
  const service = new DeveloperProfileService(deps.prisma);
  return async function plugin(app: FastifyInstance) {
    app.get('/developer-profiles', { config: { policy: ORG_ADMIN } }, async (req) => {
      const q = z.object({ q: z.string().optional() }).safeParse(req.query);
      const organizationId = requireOrganizationId(req);
      if (q.success && q.data.q) return service.searchByLoginOrName(q.data.q, organizationId);
      return service.list(organizationId);
    });

    app.patch<{ Params: { id: string } }>('/developer-profiles/:id', { config: { policy: ORG_ADMIN } }, async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      const body = DeveloperProfileLinkSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      try {
        const linked = await service.linkToUser(
          params.data.id,
          body.data.userId,
          requireOrganizationId(req),
        );
        if (!linked) return reply.code(404).send({ error: 'Developer profile not found' });
        return reply.code(204).send();
      } catch (err) {
        // Maps TargetNotInOrganizationError to 404, never 403: a 403 would
        // confirm the user exists to a caller outside their organization.
        // Rethrows anything unrecognised rather than swallowing it as a 409.
        return mapWriteError(err, reply);
      }
    });
  };
}
