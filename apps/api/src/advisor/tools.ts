import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  listBoardRowsInputSchema,
  listUnclassifiedTasksInputSchema,
  meetsBoardRole,
  proposeBoardChangesInputSchema,
  setFocusVerdictsInputSchema,
  type AccessRoleValue,
  type EffectiveBoardRole,
  type ProposeBoardChangesInput,
  type ProposeBoardChangesResultDto,
} from '@deckgauge/shared';
import type { ClickhouseIntelligenceService } from '../intelligence/clickhouse-intelligence.service.js';
import type { BoardScope } from '../intelligence/board-scope.js';
import type { BoardReadsService } from './board-reads.service.js';
import type { ChangeSetService } from './change-set/change-set.service.js';
import { EMPTY_SNAPSHOT_REASON, type FocusDataDeps } from '../focus/focus-data.service.js';
import { listResidue, setVerdicts } from '../focus/focus-tools.service.js';
import type { WidgetCache } from '../widgets/widget-cache.js';

export interface AdvisorToolDeps {
  intel: ClickhouseIntelligenceService;
  boardReads: BoardReadsService;
  changeSets: ChangeSetService;
  /** The authenticated caller, from the verified JWT — never from tool input. */
  userId: string;
  /** The caller's organization, from `request.membership` — never from tool input. */
  membership: { organizationId: string };
  /**
   * What `list_unclassified_tasks` and `set_focus_verdicts`
   * (`focus/focus-tools.service.ts`'s `listResidue` and `setVerdicts`) need to
   * read and write Focus verdicts for the board these tools are scoped to.
   * Both surfaces that build an `AdvisorToolDeps` — `advisor.routes.ts` and
   * `mcp/board-tools.ts` — already resolve a request-scoped
   * `prisma`/`clickhouse`/organization for their own tools, so this is the
   * same values, reused rather than re-derived.
   */
  focusTools: FocusDataDeps;
  /**
   * The label `set_focus_verdicts` stamps onto the `focus_verdicts.model`
   * column — provenance for who actually authored a MODEL verdict.
   *
   * Required, not optional, for the same reason `AdvisorToolContext.role` is:
   * `setVerdicts` takes this as a caller-supplied parameter rather than
   * hardcoding it precisely because BOTH surfaces register the same write tool
   * with a DIFFERENT author. The MCP surface (`mcp/board-tools.ts`) is always a
   * user's own local coding agent, so it supplies the fixed literal
   * `'claude-code (local bridge)'`. The conversational surface
   * (`advisor.routes.ts`) is always a configured server-side provider, so it
   * supplies that org's resolved `AdvisorProviderConfig.model` instead. A call
   * site that forgot this field would have to invent a value — and the one
   * value a future author would reach for first, a hardcoded literal, is
   * correct for exactly one of the two surfaces and a false provenance claim on
   * the other. There is no default that is honest on both, so there is no
   * default at all.
   */
  verdictModelLabel: string;
  /**
   * The widget-data plugin's own cache instance (Task 3-12) — the SAME one
   * `widgetDataRoutes` holds, threaded through by both surfaces that build an
   * `AdvisorToolDeps` (`advisor.routes.ts` and `mcp/board-tools.ts`), exactly
   * like `focusTools` above. `set_focus_verdicts` calls `cache.invalidateBoard`
   * after writing, or the board it just wrote to keeps serving a stale cached
   * payload for up to the cache's TTL — the same failure
   * `focus-classify.routes.ts:103` already prevents for the button. A second,
   * independently-constructed `WidgetCache` here would compile and run fine
   * while evicting nothing real, which is why both call sites are pinned by an
   * identity assertion rather than a "was this called" one.
   */
  cache: WidgetCache;
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

// The single source of truth for the board-scoped advisor tools — eight reads
// (seven analytics/board reads plus `list_unclassified_tasks`, which reads
// only despite driving the classification pipeline — see its own comment
// below) and two mutating tools: `propose_board_changes`, which proposes, and
// `set_focus_verdicts`, the one stated exception that writes directly (see
// the comment beside each). Each spec carries its own `minRole`, ENFORCED on
// both surfaces (`buildAdvisorTools` by composition, `registerBoardTools` by
// refusal). Both the AI-SDK loop (buildAdvisorTools) and the MCP server
// derive from this. `scope` is deliberately NOT part of any inputSchema — the
// model cannot widen it.
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
  /**
   * THE RULE for a mutating tool in this catalogue: PROPOSE, never write
   * directly. `propose_board_changes` below persists a row (an
   * `AdvisorChangeSet`) but does not touch the board's own content — its
   * description tells the model, in the strongest terms, that there is no
   * apply tool and it must not claim the change is made.
   *
   * `set_focus_verdicts`, at the end of this array, is the ONE STATED
   * EXCEPTION to that rule — the first `mutates: true` tool in this repo that
   * writes directly. Read its comment before adding a THIRD mutating tool: the
   * rule and its exception belong together, and an undocumented exception is
   * how a rule quietly stops being one.
   */
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
  /**
   * Task 3-9. Runs the classification pipeline's cheap tiers (cache, board
   * CAPEX/OPEX flags — own and inherited — and keyword rules) against this
   * board and hands back exactly what none of them could answer: the genuine
   * residue, never every unclassified row. See `focus-tools.service.ts`'s
   * `listResidue` for what "genuine residue" means and why a naive query for
   * "no verdict row" would answer wrongly (it would re-offer tasks the rule
   * tier would resolve for free on the next render).
   *
   * **`mutates: false`, deliberately, even though this drives the real
   * classification pipeline.** That looks like it should persist something —
   * `classifyTasks` normally saves what it decides — but the classifier
   * `listResidue` hands it always answers `[]`, so no MODEL verdict is ever
   * produced along this path, and RULE/CAPEX verdicts were never persisted to
   * begin with: `classification.service.ts`'s `CACHEABLE` set admits only
   * HUMAN and MODEL (a person's decision, or an expensive call worth
   * remembering — RULE and CAPEX are cheap to recompute and would go stale in
   * a cache the instant the board or the rules changed). So this tool reads
   * the board, runs real cheap-tier logic against it, and writes nothing at
   * all — a reader who assumes "runs the pipeline" implies "persists
   * something" would be wrong here specifically, which is exactly why this
   * comment exists.
   */
  {
    name: 'list_unclassified_tasks',
    minRole: 'VIEWER',
    mutates: false,
    description:
      'List Focus board tasks that no cached verdict, board CAPEX/OPEX flag (own or inherited from a parent), or keyword rule could classify — ' +
      'the genuine unresolved residue, never every unclassified row. ' +
      "Use this when no advisor LLM provider is configured for this organization, so an operator's own local coding agent classifies Focus tasks instead. " +
      'For each task returned, decide class "A" (roadmap/CAPEX — delivers one of the listed epics or a named programme), "B" (OPEX — a customer-visible bug, ' +
      'performance defect, or one-off operational request), or "C" (internal technical — refactoring, tooling, test debt, CI, no roadmap outcome stated); ' +
      'a one-sentence reason under 400 characters; and an epicKey from the epics list ONLY when the task clearly advances one of them (null otherwise — never invent one). ' +
      'Then call set_focus_verdicts with your verdicts. remaining > 0 means call this again (the same or a larger limit) to keep paging through what is left. ' +
      'An emptyReason field in the response means this board has no issue source configured — say so rather than reporting nothing to classify; ' +
      'an empty tasks list WITHOUT emptyReason means the board genuinely has nothing left for you to classify. ' +
      "The response's window field states the date range this call actually scanned (days, from, to) — it is a fixed lookback, not necessarily the range the operator has the board's period picker set to. " +
      'State that window when you report your findings (e.g. "scanned the last N days"), so the operator can see whether it matches what they are looking at.',
    inputSchema: listUnclassifiedTasksInputSchema,
    handler: async ({ limit }, { boardId }, { focusTools }) => {
      const result = await listResidue(focusTools, boardId, limit);
      // No issue source on this board — distinct from "nothing left to
      // classify" (an empty `tasks` array with `remaining: 0`), exactly as
      // `listResidue`'s own header requires. Mirrors the
      // `{ emptyReason: EMPTY_SNAPSHOT_REASON }` shape `widget-data.service.ts`
      // reports for the same null, so the two surfaces agree on what an
      // unconfigured issue source looks like.
      if (!result) {
        return { tasks: [], epics: [], remaining: 0, emptyReason: EMPTY_SNAPSHOT_REASON };
      }
      return result;
    },
  },
  /**
   * Task 3-10. THE STATED EXCEPTION to "a mutating tool proposes, it never
   * writes directly" (see the comment beside `propose_board_changes` above).
   * This is the first `mutates: true` tool in this repo that writes DIRECTLY,
   * and the exception is deliberate, not a shortcut — three properties that
   * are all true of a class verdict and none of which are true of a board
   * change set:
   *
   *   - REVERSIBLE: a verdict is one row in `focus_verdicts`, freely
   *     overwritable by a later call, human or agent.
   *   - INDIVIDUALLY OVERRIDABLE through the human verdict path: a HUMAN
   *     verdict always outranks a MODEL one at read time (`resolveVerdict`'s
   *     precedence), and `setVerdicts` refuses to even touch a fingerprint
   *     already holding a HUMAN row — so nothing this tool writes can survive
   *     a person's disagreement with it.
   *   - SCOPED to one column-triple (class, epicKey, reason) on rows that
   *     ALREADY EXIST: it cannot create, delete, move, or rename anything, and
   *     it cannot touch any row outside the fingerprint set the board's
   *     current window resolved to (`captureFingerprintsAndEpics` in
   *     `focus-tools.service.ts`).
   *
   * `propose_board_changes` restructures data other people depend on — groups,
   * statuses, ownership — which is expensive to undo and easy to misattribute,
   * and that is exactly why it stops at a preview a human must approve. None
   * of that is true here. The NEXT mutating tool added to this catalogue
   * should default to PROPOSING, and should have to argue for an exception
   * this explicit if it wants to write directly.
   *
   * The tool description below has its own, separate job: telling the model
   * to report the COUNTS THIS TOOL RETURNED (`written`/`rejected`) rather than
   * the model's own tally of what it sent — the same narration failure
   * `propose_board_changes`'s description (`nextStep`, above) already exists
   * to prevent, applied here to a tool that actually did write something
   * instead of one that didn't.
   */
  {
    name: 'set_focus_verdicts',
    minRole: 'EDITOR',
    mutates: true,
    description:
      "Write your classification verdicts for Focus board tasks obtained from list_unclassified_tasks. " +
      "This DOES change the board's stored verdicts directly — unlike every other write in this catalogue, there is no proposal step and no separate apply. " +
      'Each verdict is { id, class, epicKey, reason }; id must be a task id returned by list_unclassified_tasks — a made-up or stale id is rejected, not silently ignored. ' +
      'A verdict for a task a human has already classified is refused, not overwritten, and reported per-id in rejected rather than as an error. ' +
      'After calling this, report back exactly the written and rejected counts this tool returned — never your own tally of how many verdicts you sent or believe you classified. ' +
      "A rejected entry can usually be corrected and resent (e.g. call list_unclassified_tasks again if a task id looks stale); read each one's reason before retrying.",
    inputSchema: setFocusVerdictsInputSchema,
    handler: async ({ verdicts }, { boardId }, { focusTools, userId, verdictModelLabel, cache }) => {
      const result = await setVerdicts(focusTools, boardId, verdicts, userId, verdictModelLabel);
      // After the write, so a call that resolved to nothing written still
      // evicts — same ordering `focus-verdict.routes.ts` uses, and the same
      // reason: a fully-rejected batch is a normal outcome, not a no-op, and
      // there is no cheaper way to know in advance that nothing would change.
      cache.invalidateBoard(boardId);
      return result;
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
