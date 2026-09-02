import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  listBoardRowsInputSchema,
  meetsBoardRole,
  proposeBoardChangesInputSchema,
  type AccessRoleValue,
  type EffectiveBoardRole,
  type ProposeBoardChangesInput,
  type ProposeBoardChangesResultDto,
} from '@deckgauge/shared';
import type { ClickhouseIntelligenceService } from '../intelligence/clickhouse-intelligence.service.js';
import type { BoardScope } from '../intelligence/board-scope.js';
import type { BoardReadsService } from './board-reads.service.js';
import type { ChangeSetService } from './change-set/change-set.service.js';

export interface AdvisorToolDeps {
  intel: ClickhouseIntelligenceService;
  boardReads: BoardReadsService;
  changeSets: ChangeSetService;
  /** The authenticated caller, from the verified JWT — never from tool input. */
  userId: string;
  /** The caller's organization, from `request.membership` — never from tool input. */
  membership: { organizationId: string };
}

/**
 * What a tool handler is allowed to know about the board it was authorized
 * against. `boardId` is here because `BoardScope` deliberately carries no id —
 * it is the analytics filter (Jira keys, repo names), not an identity — and
 * board-content reads need the board itself.
 *
 * All three fields are closure state set by the caller AFTER authorization.
 * None is ever a tool input field: the model must not be able to widen its
 * scope, retarget another board, or claim a role it does not hold.
 */
export interface AdvisorToolContext {
  boardId: string;
  scope: BoardScope;
  /**
   * The caller's EFFECTIVE role on `boardId`, resolved by
   * `AccessService.getEffectiveRole` the same way the `/mcp` surface resolves
   * it (`mcp/board-tools.ts`). `null` means no access at all.
   *
   * This is what `buildAdvisorTools` filters the toolset by. It is required —
   * not optional with a permissive default — because a call site that forgets
   * it must fail to compile rather than silently register every tool at the
   * VIEWER floor, which is precisely the defect this field exists to close.
   */
  role: EffectiveBoardRole;
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
  /**
   * The declared truth about whether this tool changes anything — asserted
   * against `minRole`, never inferred from the tool's name. A name prefix
   * (`get_`, `propose_`, ...) is a convention a future spec can violate by
   * accident; this field is a fact the spec author must state, and a future
   * write tool that omits it fails to COMPILE rather than silently defaulting
   * to "safe" (there is no default — required, not optional).
   *
   * `propose_board_changes` is `mutates: true` even though it does not change
   * board CONTENT: it persists a new row (`advisor_change_sets`), which is a
   * real write, and that write is exactly why it must sit above the VIEWER
   * floor — a model that can create rows in another user's pending-changes
   * list is not read-only, regardless of the fact that nothing on the board
   * itself moves until a human applies it.
   */
  mutates: boolean;
  inputSchema: z.ZodType<I>;
  handler: (input: I, ctx: AdvisorToolContext, deps: AdvisorToolDeps) => Promise<unknown>;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

// The single source of truth for the board-scoped advisor tools — seven reads
// and one proposal writer, each carrying its own `minRole`, ENFORCED on both
// surfaces (`buildAdvisorTools` by composition, `registerBoardTools` by refusal).
// Both the AI-SDK loop (buildAdvisorTools) and the MCP server derive from this.
// `scope` is deliberately NOT part of any inputSchema — the model cannot widen it.
export const ADVISOR_TOOL_SPECS: AdvisorToolSpec[] = [
  {
    name: 'get_team_overview',
    minRole: 'VIEWER',
    mutates: false,
    description:
      'Team KPIs (PRs merged, median cycle time, active devs, AI-assisted %) over the last N days for this board.',
    inputSchema: z.object({ fromDays: z.number().int().min(1).max(365).default(90) }),
    handler: ({ fromDays }, { scope }, { intel }) =>
      intel.getTeamOverview(daysAgo(fromDays), new Date(), scope),
  },
  {
    name: 'find_slowdowns',
    minRole: 'VIEWER',
    mutates: false,
    description: 'Developers whose merge throughput dropped sharply recently vs. their baseline.',
    inputSchema: z.object({ thresholdPct: z.number().max(0).default(-0.4) }),
    handler: ({ thresholdPct }, { scope }, { intel }) => intel.detectSlowdownAnomalies(thresholdPct, scope),
  },
  {
    name: 'get_ai_breakdown',
    minRole: 'VIEWER',
    mutates: false,
    description: 'AI-assisted PR share per developer over the last N days.',
    inputSchema: z.object({ fromDays: z.number().int().min(1).max(365).default(90) }),
    handler: ({ fromDays }, { scope }, { intel }) => intel.getAiBreakdownByDeveloper(daysAgo(fromDays), scope),
  },
  {
    name: 'get_ticket_timeline',
    minRole: 'VIEWER',
    mutates: false,
    description: 'Unified activity timeline (Jira/GitHub/GitLab/ADO) for one ticket key.',
    inputSchema: z.object({ ticketKey: z.string().min(1) }),
    handler: ({ ticketKey }, { scope }, { intel }) => intel.getTicketTimeline(ticketKey, scope),
  },
  {
    name: 'list_board_rows',
    minRole: 'VIEWER',
    mutates: false,
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
    mutates: false,
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
    mutates: false,
    description:
      'Rows that were deleted from this board and are therefore excluded from re-sync — the board\'s blacklist. ' +
      'Use this to explain why an issue that exists in Jira/GitHub/ADO/GitLab is missing from the board. ' +
      'The ids returned here are what a future restore refers to.',
    inputSchema: z.object({}),
    handler: (_input, { boardId }, { boardReads }) => boardReads.listExcluded(boardId),
  },
  {
    name: 'propose_board_changes',
    minRole: 'EDITOR',
    mutates: true,
    description:
      'PROPOSE a batch of board changes for the user to approve. This does NOT change the board. ' +
      'It returns a changeSetId and a row-level preview; only the user can apply it, in Deckgauge. ' +
      'There is no apply tool — do not look for one, and do not tell the user you have made the change. ' +
      'Ops: create_group{name}; move_rows{rowIds,targetGroupId}; set_fields{rowIds,patch{name,description,statusId,owner}}. ' +
      'Get valid rowIds from list_board_rows and valid groupId/statusId from get_board_structure — a label is not an id. ' +
      'To move rows into a group you are also creating, set targetGroupId to "$0" where 0 is the index of the create_group op. ' +
      'Report the preview to the user and stop; say the change is waiting for their approval.',
    inputSchema: proposeBoardChangesInputSchema,
    handler: async (
      input: ProposeBoardChangesInput,
      { boardId },
      { changeSets, membership, userId },
    ): Promise<ProposeBoardChangesResultDto> => {
      const result = await changeSets.propose({
        boardId,
        organizationId: membership.organizationId,
        userId,
        ops: input.ops,
      });
      // A rejection is returned to the model as data, not thrown: it names the
      // offending op index so the model can correct and re-propose, which is a
      // normal outcome rather than an error condition. (The one exception,
      // opIndex -1, is the propose-time total-row cap — a change-set-level
      // rejection with no single offending op — and its `reason` text already
      // says so in full sentences, so it reads sensibly without any op number.)
      if (!result.ok) {
        return { proposed: false as const, errors: result.errors };
      }
      // Shaped as ProposeBoardChangesResultDto, deliberately WITHOUT anything
      // resembling an apply handle. `nextStep` is prose the model repeats to the
      // user; without it, models narrate a proposal as though it were done.
      return {
        proposed: true as const,
        changeSetId: result.changeSet.id,
        status: 'PENDING' as const,
        summary: result.changeSet.summary,
        preview: result.changeSet.preview,
        nextStep:
          'Nothing has changed yet. Report this preview to the user and tell them it is ' +
          'waiting for their approval in Deckgauge. You cannot apply it — there is no tool for that.',
      };
    },
  },
];

/**
 * The hosted-model half of the tool surface — and, like `registerBoardTools`
 * for `/mcp`, the place that ENFORCES `spec.minRole`.
 *
 * The floor is applied by COMPOSITION rather than by refusing at call time: a
 * tool the caller may not use is never registered, so the model is never told
 * it exists. That is the right shape here because, unlike `/mcp` (one long-
 * lived connection whose `boardId` arrives per call), this toolset is built
 * fresh per `/ask` request against one already-authorized board — there is
 * nothing to re-decide mid-conversation, and a tool that exists but always
 * errors just wastes steps and invites the model to narrate a refusal as a
 * capability.
 *
 * `ctx` — including `ctx.role` — is captured from the closure; never a tool
 * input field.
 */
export function buildAdvisorTools(deps: AdvisorToolDeps, ctx: AdvisorToolContext): ToolSet {
  const out: ToolSet = {};
  for (const spec of ADVISOR_TOOL_SPECS) {
    if (!meetsBoardRole(ctx.role, spec.minRole)) continue;
    out[spec.name] = tool({
      description: spec.description,
      inputSchema: spec.inputSchema,
      execute: (input) => spec.handler(input, ctx, deps),
    });
  }
  return out;
}
