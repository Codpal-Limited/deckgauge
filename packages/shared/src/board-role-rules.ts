// Pure authorization rules. This module must never import Prisma or perform
// I/O — that is what makes it exhaustively testable, what lets the enterprise
// capability resolver reuse it, and what lets the WORKER share the one copy of
// the rule instead of keeping a second one that can drift.
//
// Roles are spelled with `AccessRoleValue` rather than Prisma's
// `BoardAccessRole`; the two unions are identical members (see access.ts), and
// using the local one is what keeps packages/shared free of a Prisma dependency.
import { ACCESS_ROLE_RANK, type AccessRoleValue } from "./access";
import { ORG_ROLE_RANK, type OrgRoleValue } from "./org";

/** `null` means no access to the board at all. */
export type EffectiveBoardRole = AccessRoleValue | null;

/**
 * The ceiling rule (spec D3): a board grant may narrow the caller's reach but
 * never widen it beyond their organization role.
 */
export function effectiveBoardRole(
  orgRole: OrgRoleValue,
  grant: AccessRoleValue | null,
): EffectiveBoardRole {
  if (orgRole === "ADMIN") return "OWNER";
  if (!grant) return null;
  if (orgRole === "VIEWER") return "VIEWER";
  return grant;
}

/**
 * The same rule as `effectiveBoardRole` MINUS the org-ADMIN floor — for entities
 * marked personal (an employee board with `isPersonal`, org-tree privacy D5).
 *
 * The ceiling is kept, deliberately: an org VIEWER must not reach EDITOR anywhere,
 * privacy or not. What is dropped is the floor, because "personal except from the
 * admins" is not personal, and the admin bit is an instance-level break-glass
 * signal granted on a fresh install to whoever authenticates first.
 *
 * Lives here, beside the rule it derives from, because TWO call sites need it —
 * the `employeeBoard` policy branch (which decides whether a request is allowed)
 * and `AccessService.getEffectiveRole` (which decides what the client renders).
 * A drift between those two shows up as a control that renders and then 403s, and
 * there is no compiler signal for it.
 */
export function personalBoardRole(
  orgRole: OrgRoleValue,
  grant: AccessRoleValue | null,
): EffectiveBoardRole {
  if (!grant) return null;
  if (orgRole === "VIEWER") return "VIEWER";
  return grant;
}

export function meetsBoardRole(effective: EffectiveBoardRole, min: AccessRoleValue): boolean {
  if (!effective) return false;
  return ACCESS_ROLE_RANK[effective] >= ACCESS_ROLE_RANK[min];
}

export function meetsOrgRole(orgRole: OrgRoleValue, min: OrgRoleValue): boolean {
  return ORG_ROLE_RANK[orgRole] >= ORG_ROLE_RANK[min];
}

export function canCreateBoard(orgRole: OrgRoleValue): boolean {
  return orgRole !== "VIEWER";
}

export function canManageOrg(orgRole: OrgRoleValue): boolean {
  return orgRole === "ADMIN";
}
