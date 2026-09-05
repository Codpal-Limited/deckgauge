/**
 * Maps default board status labels to their ProjectStatus enum equivalents.
 * Custom board status labels that don't appear here won't trigger enum-value
 * automations — they match on their label instead (see evaluate-automations).
 */
export const BOARD_STATUS_LABEL_TO_ENUM: Record<string, string> = {
  'Not Started': 'NOT_STARTED',
  'In Progress': 'IN_PROGRESS',
  'At Risk': 'AT_RISK',
  'Blocked': 'BLOCKED',
  'Done': 'DONE',
};
