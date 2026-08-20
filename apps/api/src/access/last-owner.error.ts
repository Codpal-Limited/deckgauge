import type { AccessEntityKind } from '@deckgauge/shared';

/**
 * An entity with no OWNER is administrable only by an org admin: nobody can
 * share it, restore an owner, or delete it. Refuse the operation rather than
 * create that state.
 *
 * One typed error for all five entity kinds, replacing three variants — one of
 * which was a bare `new Error('Cannot remove the last roadmap owner')` matched
 * by string comparison in its route handler.
 */
export class LastOwnerError extends Error {
  constructor(public readonly kind: AccessEntityKind) {
    super(`Cannot remove or demote the last owner of this ${kind}`);
    this.name = 'LastOwnerError';
  }
}

/**
 * The grant target is not an ACTIVE member of the granting caller's
 * organization — or holds a PENDING invite, which has no bound user and so
 * cannot hold an access row.
 *
 * Routes map this to 404, never 403: a 403 would confirm to a caller outside the
 * organization that the user exists (tenancy D7).
 */
export class TargetNotInOrganizationError extends Error {
  constructor() {
    super('User not found');
    this.name = 'TargetNotInOrganizationError';
  }
}

/**
 * The requested role would grant more than the target's organization role
 * permits (the ceiling rule, design D3/D7): `effectiveBoardRole` would not
 * honour it — an org VIEWER caps at VIEWER, an org ADMIN is implicit OWNER
 * regardless of the stored grant. Storing a role the system will silently
 * reinterpret would make `AccessEntry.role` a promise the effective-role
 * check does not keep.
 *
 * Routes map this to 409, not 400: the request is well-formed, it is the
 * target's organization role that makes it unsatisfiable.
 */
export class RoleExceedsOrgRoleError extends Error {
  constructor() {
    super("Requested role exceeds what the target's organization role permits");
    this.name = 'RoleExceedsOrgRoleError';
  }
}
