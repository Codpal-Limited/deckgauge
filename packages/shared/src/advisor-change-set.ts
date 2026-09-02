import { z } from 'zod';

/** Ops per change-set. A cap, not a guess: the preview must stay reviewable by a human. */
export const MAX_OPS_PER_CHANGE_SET = 50;
/**
 * Rows one op may target. Bounds the preview size for a single op, but NOT
 * the apply transaction — a 50-op change-set each carrying 500 rows still
 * reaches ~25,000 sequential writes. `MAX_TOTAL_ROWS_PER_CHANGE_SET` below is
 * what actually bounds the transaction; enforced once, at propose time,
 * across every op in the set.
 */
export const MAX_ROWS_PER_OP = 500;
/**
 * Total rowIds across every op in a change-set, enforced at propose time
 * (`ChangeSetService.propose`). `MAX_ROWS_PER_OP` bounds one op; without a
 * total, `MAX_OPS_PER_CHANGE_SET` ops each at the per-op cap still produce a
 * change-set the apply transaction cannot realistically execute within any
 * fixed timeout.
 */
export const MAX_TOTAL_ROWS_PER_CHANGE_SET = 500;

/**
 * A forward reference to an earlier op's created entity: `"$0"` means "the group
 * created by op 0".
 *
 * Deliberately strict — `$0`, `$12`, never `$01` or `$-1`. A malformed reference
 * must fail validation loudly rather than be coerced into an index, because the
 * consequence of guessing wrong is rows moved into the wrong group.
 */
export const OP_REF_PATTERN = /^\$(0|[1-9][0-9]*)$/;

export function parseOpRef(value: string): number | null {
  const m = OP_REF_PATTERN.exec(value);
  return m ? Number(m[1]) : null;
}

/** A group target: either a real group id, or a reference to an earlier create_group. */
const groupTargetSchema = z.union([z.string().uuid(), z.string().regex(OP_REF_PATTERN)]);

const rowIdsSchema = z.array(z.string().uuid()).min(1).max(MAX_ROWS_PER_OP);

const createGroupOpSchema = z.object({
  op: z.literal('create_group'),
  name: z.string().trim().min(1).max(100),
});

const moveRowsOpSchema = z.object({
  op: z.literal('move_rows'),
  rowIds: rowIdsSchema,
  targetGroupId: groupTargetSchema,
});

/**
 * The editable built-in fields. Custom column values are a separate op
 * (`set_column_value`, stage 2b) because they route through a different service.
 *
 * `statusId`, not a status label: statuses are per-board rows with ids, so a
 * label is not addressable. The model gets ids from `get_board_structure`.
 */
const setFieldsPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(20000).nullable().optional(),
    statusId: z.string().uuid().optional(),
    // owner deliberately trims without a minimum, unlike `name` above:
    // Project.owner treats "" as the meaningful "unassigned" value, so an
    // explicit clear must stay valid. Only whitespace-only input is wrong —
    // it isn't a name and isn't a clear — so trim normalises "   " to "" rather
    // than storing stray whitespace as an owner.
    //
    // Deliberately NOT `assignee`: that column is the tracker's synced
    // identity value, written only by the worker's Jira/ADO/GitHub/GitLab sync
    // (jira-promote.service.ts et al.) for employee matching in timesheet and
    // org-tree code. `UpdateProjectInputSchema` has no `assignee` field and
    // `ProjectService.update` never writes it, so offering it here would be a
    // patch key the applier can only silently drop — found and closed in Task
    // 6 (change-set-apply.service.ts). If stage 2b ever wants the Advisor to
    // set an assignment, it goes through whichever write path actually owns
    // that column — not by widening this patch.
    owner: z.string().trim().max(200).optional(),
  })
  // .strict(), not the z.object() default: a plain z.object() SILENTLY STRIPS
  // unrecognized keys, so a mixed patch like { name: 'x', assignee: 'y' } —
  // the realistic case, since a model asking to reassign usually also
  // touches something else — would parse to `success: true` with `assignee`
  // simply gone. That is the same silent-drop failure this file already
  // fixed once for an assignee-only patch (the empty-patch refine below only
  // catches the case where NOTHING recognized survives); .strict() makes an
  // unsupported key a loud rejection instead, carrying the op index the
  // caller can act on.
  .strict()
  .refine((p) => Object.keys(p).length > 0, {
    message: 'patch must set at least one field',
  });

const setFieldsOpSchema = z.object({
  op: z.literal('set_fields'),
  rowIds: rowIdsSchema,
  patch: setFieldsPatchSchema,
});

export const boardOpSchema = z.discriminatedUnion('op', [
  createGroupOpSchema,
  moveRowsOpSchema,
  setFieldsOpSchema,
]);

export type BoardOp = z.infer<typeof boardOpSchema>;

export const proposeBoardChangesInputSchema = z.object({
  ops: z.array(boardOpSchema).min(1).max(MAX_OPS_PER_CHANGE_SET),
});

export type ProposeBoardChangesInput = z.infer<typeof proposeBoardChangesInputSchema>;

/** One row-level line of the preview a human approves. */
export interface AdvisorChangeSetPreviewRowDto {
  rowId: string;
  rowName: string;
  /** e.g. "group: Backlog → Untriaged", "status: In progress → In review" */
  changes: string[];
}

export interface AdvisorChangeSetPreviewDto {
  /** Human-readable line per op, in order. */
  opSummaries: string[];
  rows: AdvisorChangeSetPreviewRowDto[];
  /** Groups this change-set would create, by op index. */
  createdGroups: { opIndex: number; name: string }[];
  /**
   * Fields that will become manually overridden if applied, and therefore stop
   * tracking their sync source until reverted.
   *
   * NOT a "your edit will be reverted" warning — `shouldSync()` in
   * sync-field-registry gives an override precedence over the board allow-list,
   * and `ProjectService.update` marks every field it touches. So the honest
   * warning is the opposite: the edit sticks, and the row stops following the
   * tracker for that field.
   */
  overrideNotes: string[];
  /**
   * True when an op referenced a row that PreviewContext does not have (not
   * loaded, or not on this board) — that row's effect is missing below, so
   * the preview is partial for the op that named it. NOT a row-list cap;
   * nothing in this preview enforces one, and absence from context is the
   * only trigger.
   */
  truncated: boolean;
}

export type AdvisorChangeSetStatusDto =
  | 'PENDING'
  | 'APPLIED'
  | 'DISCARDED'
  | 'STALE'
  | 'EXPIRED';

export interface AdvisorChangeSetDto {
  id: string;
  boardId: string;
  status: AdvisorChangeSetStatusDto;
  summary: string;
  ops: BoardOp[];
  preview: AdvisorChangeSetPreviewDto;
  expiresAt: string;
  appliedAt: string | null;
  createdAt: string;
}

/** One op that failed validation, by position in the submitted `ops` array. */
export interface BoardOpErrorDto {
  opIndex: number;
  reason: string;
}

/**
 * What the tool returns to the model — deliberately NOT an apply handle.
 *
 * A discriminated union on `proposed`, not a success-only shape: a rejected
 * proposal is an ordinary outcome the model should correct and retry, and it
 * needs the op index to do that. Modeling it as a thrown exception instead
 * would reach the model as an opaque tool failure with no index to act on.
 */
export type ProposeBoardChangesResultDto =
  | {
      proposed: true;
      changeSetId: string;
      status: 'PENDING';
      summary: string;
      preview: AdvisorChangeSetPreviewDto;
      /** Told to the model verbatim so it stops and reports rather than retrying. */
      nextStep: string;
    }
  | {
      proposed: false;
      errors: BoardOpErrorDto[];
    };
