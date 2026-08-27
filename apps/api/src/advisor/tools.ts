import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { listBoardRowsInputSchema, type AccessRoleValue } from '@deckgauge/shared';
import type { ClickhouseIntelligenceService } from '../intelligence/clickhouse-intelligence.service.js';
import type { BoardScope } from '../intelligence/board-scope.js';
import type { BoardReadsService } from './board-reads.service.js';

export interface AdvisorToolDeps {
  intel: ClickhouseIntelligenceService;
  boardReads: BoardReadsService;
}

/**
 * What a tool handler is allowed to know about the board it was authorized
 * against. `boardId` is here because `BoardScope` deliberately carries no id —
 * it is the analytics filter (Jira keys, repo names), not an identity — and
 * board-content reads need the board itself.
 *
 * Both fields are closure state set by the caller AFTER authorization. Neither
 * is ever a tool input field: the model must not be able to widen its scope or
 * retarget another board.
 */
export interface AdvisorToolContext {
  boardId: string;
  scope: BoardScope;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface AdvisorToolSpec<I = any> {
  name: string;
  description: string;
  /**
   * The board role a caller must hold for this tool. Carried by the spec rather
   * than decided at the call site so both consumers — the AI-SDK loop and the
   * MCP server — cannot disagree about it, and so stage 2's write tools cannot
   * be registered at a read floor by omission.
   */
  minRole: AccessRoleValue;
  inputSchema: z.ZodType<I>;
  handler: (input: I, ctx: AdvisorToolContext, deps: AdvisorToolDeps) => Promise<unknown>;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

// The single source of truth for the read-only, board-scoped advisor tools.
// Both the AI-SDK loop (buildAdvisorTools) and the MCP server derive from this.
// `scope` is deliberately NOT part of any inputSchema — the model cannot widen it.
export const ADVISOR_TOOL_SPECS: AdvisorToolSpec[] = [
  {
    name: 'get_team_overview',
    minRole: 'VIEWER',
    description:
      'Team KPIs (PRs merged, median cycle time, active devs, AI-assisted %) over the last N days for this board.',
    inputSchema: z.object({ fromDays: z.number().int().min(1).max(365).default(90) }),
    handler: ({ fromDays }, { scope }, { intel }) =>
      intel.getTeamOverview(daysAgo(fromDays), new Date(), scope),
  },
  {
    name: 'find_slowdowns',
    minRole: 'VIEWER',
    description: 'Developers whose merge throughput dropped sharply recently vs. their baseline.',
    inputSchema: z.object({ thresholdPct: z.number().max(0).default(-0.4) }),
    handler: ({ thresholdPct }, { scope }, { intel }) => intel.detectSlowdownAnomalies(thresholdPct, scope),
  },
  {
    name: 'get_ai_breakdown',
    minRole: 'VIEWER',
    description: 'AI-assisted PR share per developer over the last N days.',
    inputSchema: z.object({ fromDays: z.number().int().min(1).max(365).default(90) }),
    handler: ({ fromDays }, { scope }, { intel }) => intel.getAiBreakdownByDeveloper(daysAgo(fromDays), scope),
  },
  {
    name: 'get_ticket_timeline',
    minRole: 'VIEWER',
    description: 'Unified activity timeline (Jira/GitHub/GitLab/ADO) for one ticket key.',
    inputSchema: z.object({ ticketKey: z.string().min(1) }),
    handler: ({ ticketKey }, { scope }, { intel }) => intel.getTicketTimeline(ticketKey, scope),
  },
  {
    name: 'list_board_rows',
    minRole: 'VIEWER',
    description:
      'List the rows (items/issues) on this board with their fields — name, group, status, owner, assignee, description, Jira key and custom column values. ' +
      'Use this for questions about board CONTENT: which rows are missing a description, what is in a given group, which items sit at a given status. ' +
      'Filter with hasDescription/groupId/statusId/search rather than paging through everything. ' +
      'ALWAYS compare rows.length against totalMatching before summarising: if they differ you are looking at one page, and you must say so rather than presenting it as the full list.',
    inputSchema: listBoardRowsInputSchema,
    handler: (input, { boardId }, { boardReads }) => boardReads.listRows(boardId, input),
  },
  {
    name: 'get_board_structure',
    minRole: 'VIEWER',
    description:
      "This board's groups, statuses and custom columns, with their ids, plus which row fields each connected source overwrites on every sync. " +
      'Call this before filtering or referring to a status or group: statuses are per-board rows with ids, so a status LABEL alone is not addressable. ' +
      "syncOwnedFields is the board's per-source allow-list of fields sync may write — it is not a verdict on any one edit: a manual edit to a field records an override, and an override always beats the allow-list, so being on this list does not mean an edit gets reverted.",
    inputSchema: z.object({}),
    handler: (_input, { boardId }, { boardReads }) => boardReads.getStructure(boardId),
  },
  {
    name: 'list_excluded_rows',
    minRole: 'VIEWER',
    description:
      'Rows that were deleted from this board and are therefore excluded from re-sync — the board\'s blacklist. ' +
      'Use this to explain why an issue that exists in Jira/GitHub/ADO/GitLab is missing from the board. ' +
      'The ids returned here are what a future restore refers to.',
    inputSchema: z.object({}),
    handler: (_input, { boardId }, { boardReads }) => boardReads.listExcluded(boardId),
  },
];

// `ctx` is captured from the closure; never a tool input field.
export function buildAdvisorTools(deps: AdvisorToolDeps, ctx: AdvisorToolContext): ToolSet {
  const out: ToolSet = {};
  for (const spec of ADVISOR_TOOL_SPECS) {
    out[spec.name] = tool({
      description: spec.description,
      inputSchema: spec.inputSchema,
      execute: (input) => spec.handler(input, ctx, deps),
    });
  }
  return out;
}
