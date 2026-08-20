import type { AccessEntityKind } from '@deckgauge/shared';

/** URL segment per entity kind. Phases B–D add rows; nothing else changes. */
export const ENTITY_PATHS: Record<AccessEntityKind, string> = {
  board: 'boards',
  orgTree: 'org-trees',
  employeeBoard: 'employee-boards',
  roadmap: 'roadmaps',
  comparison: 'comparisons',
};
