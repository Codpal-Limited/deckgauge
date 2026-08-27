import { z } from 'zod';

/**
 * How much of a row's description the Advisor sees per row.
 *
 * A board can hold hundreds of rows with multi-kilobyte descriptions, and the
 * whole page has to fit in a tool result the model reads in full. The cap is a
 * budget, not a guess — `descriptionTruncated` tells the model when it is
 * looking at a prefix, so it can say "truncated" instead of quietly answering
 * from half a description.
 */
export const DESCRIPTION_PREVIEW_MAX = 1000;

/** Hard ceiling on rows per page, so one tool call cannot flood the context. */
export const LIST_BOARD_ROWS_MAX_LIMIT = 200;

export const listBoardRowsInputSchema = z.object({
  groupId: z.string().min(1).optional().describe('Only rows in this group.'),
  statusId: z.string().min(1).optional().describe('Only rows with this board status id.'),
  hasDescription: z
    .boolean()
    .optional()
    .describe('true = only rows WITH a non-empty description; false = only rows WITHOUT one.'),
  search: z
    .string()
    .min(1)
    .optional()
    .describe('Case-insensitive substring match on the row name.'),
  limit: z.number().int().min(1).max(LIST_BOARD_ROWS_MAX_LIMIT).default(50),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe('Pass the previous page\'s nextCursor to continue. Omit for the first page.'),
});

export type ListBoardRowsInput = z.infer<typeof listBoardRowsInputSchema>;

export interface AdvisorBoardRowDto {
  id: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
  /** Legacy enum label, always present. */
  status: string;
  /** The board-status row, when the board has been migrated to them. */
  statusId: string | null;
  statusLabel: string | null;
  owner: string;
  assignee: string;
  description: string | null;
  descriptionTruncated: boolean;
  jiraKey: string | null;
  /** Custom column values, keyed by column id. Absent keys mean no value set. */
  columns: Record<string, string>;
}

export interface AdvisorBoardRowsDto {
  rows: AdvisorBoardRowDto[];
  /** Pass back as `cursor` for the next page; null when this is the last page. */
  nextCursor: string | null;
  /**
   * How many rows match the filter in total, not just on this page.
   *
   * Present so the model cannot mistake a first page for a complete answer —
   * "5 of 340 rows have no description" is a different sentence from "5 rows
   * have no description", and without this count it would confidently write
   * the second one.
   */
  totalMatching: number;
}

export interface AdvisorBoardStructureDto {
  groups: { id: string; name: string; position: number }[];
  statuses: { id: string; label: string; order: number; isDefault: boolean }[];
  columns: { id: string; name: string; type: string; order: number }[];
  /**
   * Which row fields each connected source overwrites on every sync.
   *
   * Here because an edit to a sync-owned field is durable only until the next
   * sync — `jira-promote.service.ts:390-411` reapplies the tracker's value for
   * anything in this list — and sync is one-way inbound, so there is nowhere to
   * push the change. The model needs this to answer "will my edit stick?"
   * honestly. GitLab sources are absent by design: `BoardGitLabSource` has no
   * `defaultSyncedFields` column.
   */
  syncOwnedFields: { source: 'JIRA' | 'GITHUB' | 'ADO'; fields: string[] }[];
}

export interface AdvisorExcludedRowDto {
  id: string;
  source: string;
  externalId: string;
  excludedAt: string;
  excludedBy: string | null;
}
