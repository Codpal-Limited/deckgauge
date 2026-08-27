// Moved to packages/shared (board-role-rules.ts) so the worker shares the ONE
// copy of the ceiling rule rather than keeping a second one that can drift — the
// notification dispatcher's reverse access check runs in both processes.
//
// Re-exported from here because roughly twenty modules import these names from
// this path, and the spec references (§5.3, D3, D5) point at it.
export {
  effectiveBoardRole,
  personalBoardRole,
  meetsBoardRole,
  meetsOrgRole,
  canCreateBoard,
  canManageOrg,
  type EffectiveBoardRole,
} from '@deckgauge/shared';
