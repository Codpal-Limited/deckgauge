import type { BootstrapState } from '../actions/organization';

/**
 * The organization-ADMIN gate, in one place.
 *
 * Three screens ask this question — the settings tab list, the Members page and
 * the connection sections of /sources — and each had spelled the condition out
 * inline, in two different shapes (positive and De Morgan'd). One predicate
 * keeps them from drifting apart, which for a permission check is the whole
 * point.
 *
 * `MEMBER` here is the bootstrap *state* (there is an active membership), not a
 * role; the role lives on the organization. Every other state — suspended,
 * no membership, unauthenticated, needs-bootstrap — has no role to read and so
 * is never an admin. Callers that need to *explain* the refusal must still
 * branch on `state`, because "you are not an admin" is false for a suspended or
 * organization-less caller.
 *
 * This is presentation only. The API gates every one of these routes itself.
 */
export function isOrganizationAdmin(state: BootstrapState): boolean {
  return state.state === 'MEMBER' && state.organization.role === 'ADMIN';
}
