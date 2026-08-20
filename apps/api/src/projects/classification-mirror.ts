import { chInsertMany } from '@deckgauge/db';

export interface ClassifiableRow {
  id: string;
  boardId: string | null;
  jiraKey: string | null;
  adoWorkItemId: number | null;
  adoProject: string | null;
  githubIssueId: string | null;
  costClassification: 'CAPEX' | 'OPEX' | null;
}

export interface BoardItemClassificationRow extends Record<string, unknown> {
  issue_key: string;
  provider: string;
  classification: string;
  board_id: string;
  project_id: string;
}

export function deriveIssueKey(
  row: ClassifiableRow,
): { issueKey: string; provider: 'jira' | 'ado' | 'github' } | null {
  if (row.jiraKey) return { issueKey: row.jiraKey, provider: 'jira' };
  if (row.adoWorkItemId != null && row.adoProject) {
    return { issueKey: `${row.adoProject}#${row.adoWorkItemId}`, provider: 'ado' };
  }
  if (row.githubIssueId) return { issueKey: row.githubIssueId, provider: 'github' };
  return null;
}

export function buildClassificationRow(row: ClassifiableRow): BoardItemClassificationRow | null {
  if (!row.costClassification || !row.boardId) return null;
  const derived = deriveIssueKey(row);
  if (!derived) return null;
  return {
    issue_key: derived.issueKey,
    provider: derived.provider,
    classification: row.costClassification,
    board_id: row.boardId,
    project_id: row.id,
  };
}

export async function mirrorClassification(row: ClassifiableRow, organizationId: string): Promise<void> {
  const mirrorRow = buildClassificationRow(row);
  if (!mirrorRow) return;
  await chInsertMany('board_item_classification', organizationId, [mirrorRow]);
}
