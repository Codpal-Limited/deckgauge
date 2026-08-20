// Pure authorization rules. This module must never import Prisma or perform
// I/O — that is what makes it exhaustively testable and what lets the
// enterprise capability resolver reuse it. See spec §5.3.
import type { BoardAccessRole } from '@deckgauge/db';
import { ORG_ROLE_RANK, type OrgRoleValue } from '@deckgauge/shared';

const BOARD_ROLE_RANK: Record<BoardAccessRole, number> = {
  VIEWER: 0,
  EDITOR: 1,
  OWNER: 2,
};

/** `null` means no access to the board at all. */
export type EffectiveBoardRole = BoardAccessRole | null;

/**
 * The ceiling rule (spec D3): a board grant may narrow the caller's reach but
 * never widen it beyond their organization role.
 */
export function effectiveBoardRole(
  orgRole: OrgRoleValue,
  grant: BoardAccessRole | null,
): EffectiveBoardRole {
  if (orgRole === 'ADMIN') return 'OWNER';
  if (!grant) return null;
  if (orgRole === 'VIEWER') return 'VIEWER';
  return grant;
}

export function meetsBoardRole(effective: EffectiveBoardRole, min: BoardAccessRole): boolean {
  if (!effective) return false;
  return BOARD_ROLE_RANK[effective] >= BOARD_ROLE_RANK[min];
}

export function meetsOrgRole(orgRole: OrgRoleValue, min: OrgRoleValue): boolean {
  return ORG_ROLE_RANK[orgRole] >= ORG_ROLE_RANK[min];
}

export function canCreateBoard(orgRole: OrgRoleValue): boolean {
  return orgRole !== 'VIEWER';
}

export function canManageOrg(orgRole: OrgRoleValue): boolean {
  return orgRole === 'ADMIN';
}
