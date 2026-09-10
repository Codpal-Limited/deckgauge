import { z } from 'zod';
import {
  FOCUS_MODEL_BUDGET,
  FocusModelVerdictSchema,
  type FocusPromptEpic,
  type FocusPromptTask,
} from './model-classifier.js';

/**
 * Schemas and result DTOs for the two MCP tools that let an operator's own
 * local coding agent classify Focus tasks when the organization has no
 * advisor LLM provider configured — `list_unclassified_tasks` and
 * `set_focus_verdicts` (registered in `apps/api/src/advisor/tools.ts`).
 *
 * This module may import only `zod` and sibling modules under
 * `packages/shared/src/focus/` — never `apps/api`, and nothing that reaches a
 * Node builtin. `server-only-boundary.test.ts` walks the shared barrel's
 * relative-import graph and fails on either violation.
 */

/**
 * Mirrors `MODEL_BATCH` in `apps/api/src/focus/classification.service.ts` —
 * the server-side batch size a normal classify run sends to a configured
 * provider per call. That const is private and unexported, and
 * `packages/shared` must never import from `apps/api`, so this is a second,
 * independent definition rather than a shared import. Kept honest by
 * `agent-tools.test.ts`'s default-value assertion; a drift between the two
 * would show up there, not at runtime.
 *
 * Exported so `focus-tools.service.ts`'s `listResidue` can default its own
 * `limit` to the same number the schema defaults to, instead of a third,
 * unrelated copy of 40.
 */
export const AGENT_TOOL_BATCH_DEFAULT = 40;

/**
 * Input to `list_unclassified_tasks`. `boardId` is deliberately absent: the
 * board comes from `AdvisorToolContext`, never from tool input, so an agent
 * cannot retarget another board by supplying one in its call.
 *
 * `limit` REJECTS a value above `FOCUS_MODEL_BUDGET` rather than clamping it
 * — a caller that asks for more than the budget allows should see why,
 * instead of silently receiving fewer tasks than it believes it requested.
 */
export const listUnclassifiedTasksInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(FOCUS_MODEL_BUDGET)
    .optional()
    .default(AGENT_TOOL_BATCH_DEFAULT),
});

export type ListUnclassifiedTasksInput = z.infer<typeof listUnclassifiedTasksInputSchema>;

/**
 * What `list_unclassified_tasks` returns to the agent.
 *
 * `tasks` and `epics` are the exact structures `buildFocusPrompt` consumes,
 * so an agent classifying through this tool sees the same material the
 * server-side prompt would have carried. `remaining` is residue left after
 * this page — non-zero tells the agent to call again.
 *
 * `emptyReason` is present only when the board has no issue source
 * configured — `focus-tools.service.ts`'s `listResidue` returns `null` for
 * that case, and `list_unclassified_tasks`'s handler turns it into this field
 * rather than an empty `tasks` array with no explanation, which would read as
 * "fully classified" instead. Declared here because the handler's own return
 * type is a bare `Promise<unknown>` — this DTO is what actually catches a
 * caller that forgets the field.
 *
 * `window` is the classification window this call actually scanned —
 * `focus-tools.service.ts:115` and `:190` run `runFocusClassification` with
 * an empty config, so the pipeline always falls back to `DEFAULT_DAYS`
 * (`apps/api/src/intelligence-query/builders/focus-task-measures.ts`) rather
 * than the board's on-screen period. Reporting it here is the transparency
 * half of that known limitation (see `planning/STATE.md`): it does not make
 * the window configurable, it only lets the agent say out loud what it
 * scanned, so a mismatch with what the operator is looking at surfaces in
 * conversation instead of silently. Optional because it is meaningless
 * alongside `emptyReason` — nothing was scanned when there is no issue
 * source.
 */
export interface ListUnclassifiedTasksResultDto {
  tasks: FocusPromptTask[];
  epics: FocusPromptEpic[];
  remaining: number;
  emptyReason?: string;
  window?: { days: number; from: string; to: string };
}

/**
 * Input to `set_focus_verdicts`. Wraps `FocusModelVerdictSchema` rather than
 * restating its fields — the agent produces exactly what a model produces,
 * so it is validated by exactly the same schema, including the 400-char
 * `reason` bound that matches `focus_verdicts.reason`, VARCHAR(400).
 *
 * `verdicts` is capped at `FOCUS_MODEL_BUDGET`, the same ceiling
 * `listUnclassifiedTasksInputSchema`'s `limit` enforces on the read side —
 * without it an agent could post an arbitrarily long array in one call, with
 * nothing on this side of the pair bounding it the way the read side already
 * is.
 */
export const setFocusVerdictsInputSchema = z.object({
  verdicts: z.array(FocusModelVerdictSchema).max(FOCUS_MODEL_BUDGET),
});

export type SetFocusVerdictsInput = z.infer<typeof setFocusVerdictsInputSchema>;

/**
 * One verdict `set_focus_verdicts` could not write, named by the task key the
 * agent supplied — the `propose_board_changes` convention: a rejection is
 * data the agent can act on and retry, not a thrown error.
 */
export interface RejectedFocusVerdictDto {
  id: string;
  reason: string;
}

/**
 * What `set_focus_verdicts` returns to the agent. The tool description tells
 * the model to report these counts verbatim rather than its own tally, the
 * same discipline `propose_board_changes`'s description enforces.
 */
export interface SetFocusVerdictsResultDto {
  written: number;
  rejected: RejectedFocusVerdictDto[];
}
