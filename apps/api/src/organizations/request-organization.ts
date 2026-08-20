import type { RequestMembership } from '../auth/fastify.js';

/**
 * Thrown when a handler that writes a tenant root is reached with no
 * organization membership on the request.
 *
 * This is a route-table bug, not a permission decision: the `orgRole` policy is
 * what guarantees a membership, so reaching a handler without one means the
 * route declared no such policy. Deliberately NOT a 403 — a plausible-looking
 * denial would hide the misconfiguration, while an unhandled Error surfaces as a
 * 500 and gets fixed.
 */
export class MissingOrganizationError extends Error {
  constructor(url: string) {
    super(
      `Route "${url}" reached its handler with no organization membership. ` +
        `Add an orgRole(...) policy to it — see apps/api/src/auth/policy.ts.`,
    );
    this.name = 'MissingOrganizationError';
  }
}

/**
 * The organization every tenant-root write belongs to, taken from the membership
 * the `orgRole` policy already guaranteed.
 *
 * Exists because `request.membership` is legitimately nullable — a first-run
 * admin heading for bootstrap has none — so its type cannot express "non-null
 * behind a policy". This narrows it in one place with one explanation, instead
 * of 16 call sites each inventing a `!` or a bespoke guard.
 */
export function requireOrganizationId(request: {
  membership?: RequestMembership | null;
  url: string;
}): string {
  if (!request.membership) throw new MissingOrganizationError(request.url);
  return request.membership.organizationId;
}
