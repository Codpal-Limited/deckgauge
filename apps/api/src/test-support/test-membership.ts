import type { FastifyInstance } from 'fastify';
import type { RequestMembership } from '../auth/fastify.js';

export const TEST_ORGANIZATION_ID = 'org-test';

/**
 * Stands in for the auth plugin, which route-level tests deliberately do not
 * register (they exercise one route family, not the whole chain).
 *
 * The plugin is what resolves `request.membership` in production, and every
 * route touching a tenant root now scopes its queries to it — so without this
 * those tests exercise a request shape that cannot occur, and
 * `requireOrganizationId` throws.
 *
 * Pass `null` to assert the opposite case: a caller with no organization.
 */
export function withTestMembership(
  app: FastifyInstance,
  membership: RequestMembership | null = {
    organizationId: TEST_ORGANIZATION_ID,
    role: 'ADMIN',
  },
): FastifyInstance {
  // Several suites already decorate `membership` themselves, and Fastify throws
  // on a duplicate decorator rather than ignoring it.
  if (!app.hasRequestDecorator('membership')) {
    app.decorateRequest('membership', null);
  }
  app.addHook('onRequest', async (req) => {
    req.membership = membership;
  });
  return app;
}
