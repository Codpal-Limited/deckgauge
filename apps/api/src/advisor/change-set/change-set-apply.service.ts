import { Prisma, type PrismaClient } from '@deckgauge/db';
import { parseOpRef, type BoardOp } from '@deckgauge/shared';
import { ProjectService, type UpdateProjectInput } from '../../projects/project.service.js';
import { loadBoardFacts, validateOps, type ValidationError } from './op-validator.js';
import { ChangeSetService } from './change-set.service.js';

export type ApplyOutcome =
  | { ok: true; applied: number }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'NOT_PENDING' | 'EXPIRED' | 'STALE' | 'FAILED';
      errors?: ValidationError[];
    };

// A change-set can legally carry up to MAX_TOTAL_ROWS_PER_CHANGE_SET rows
// spread across MAX_OPS_PER_CHANGE_SET ops, and each set_fields row runs
// several sequential queries through ProjectService.update. Prisma's 5s
// interactive-transaction default is nowhere near enough for that — same
// precedent as GroupService.delete (group.service.ts:33-34), which gives its
// own transaction a dedicated budget for the same reason (bulk sequential
// writes, not one statement).
const APPLY_TIMEOUT_MS = 60_000;
const APPLY_MAX_WAIT_MS = 10_000;

/**
 * Executes an approved change-set.
 *
 * Three properties this class exists to guarantee:
 *
 * 1. **Re-authorization happens in the route, re-VALIDATION happens here.** The
 *    change-set outlives the request that created it, so the board may have moved
 *    underneath the preview a human approved. Applying a stale preview is worse
 *    than refusing: the human approved a specific set of row changes, not "do
 *    whatever these ops mean now".
 * 2. **One transaction.** A partially applied change-set is the one outcome with
 *    no honest description — the human approved a unit.
 * 3. **Ops execute through the SAME writes the board UI uses.** `set_fields` goes
 *    through the project update path so the per-field override bookkeeping
 *    (`markOverridden`) happens exactly as it does for a manual edit; a bespoke
 *    `prisma.project.update` here would silently skip it and leave the row still
 *    tracking its sync source.
 */
export class ChangeSetApplyService {
  private readonly changeSets: ChangeSetService;

  /**
   * Test seam for forcing a failure at a chosen op index, so atomicity can be
   * proven rather than assumed. Follows the repo's existing `_`-prefixed
   * injectable-seam idiom (see `RoadmapItemService._setSchedule`). Async so a
   * test can also use it to simulate a concurrent writer landing mid-
   * transaction (see the double-apply race test) without needing real
   * concurrency.
   *
   * @internal
   */
  _afterOp?: (opIndex: number) => void | Promise<void>;

  constructor(private readonly prisma: PrismaClient) {
    this.changeSets = new ChangeSetService(prisma);
  }

  /**
   * @param boardId The board the ROUTE authorized — `req.params.boardId`, the
   *   value `board('EDITOR', viaBoardId(fromParam('boardId')))` proved EDITOR
   *   on. It is joined onto the change-set lookup below so that the authorized
   *   board and the board every write inside the transaction targets
   *   (`cs.boardId`) cannot be two different boards. See
   *   `ChangeSetService`'s class comment for the escalation this closes.
   */
  async apply(
    id: string,
    boardId: string,
    organizationId: string,
    userId: string,
  ): Promise<ApplyOutcome> {
    // Through the service, NOT a local findFirst: the four predicates (id,
    // board, organization, creator) are the authorization rule, and a second
    // copy of them is a second thing to get wrong. One place, one shape.
    //
    // getForApply deliberately applies no status/expiry filter (it returns
    // APPLIED, DISCARDED, STALE and EXPIRED rows as readily as PENDING ones) —
    // so the two checks immediately below are not redundant with the lookup,
    // they are the only place that decides whether a found change-set is safe
    // to apply.
    const cs = await this.changeSets.getForApply(id, boardId, organizationId, userId);
    if (!cs) return { ok: false, code: 'NOT_FOUND' };
    if (cs.status !== 'PENDING') return { ok: false, code: 'NOT_PENDING' };
    if (cs.expiresAt.getTime() <= Date.now()) {
      await this.prisma.advisorChangeSet.update({ where: { id }, data: { status: 'EXPIRED' } });
      return { ok: false, code: 'EXPIRED' };
    }

    const ops = cs.ops as unknown as BoardOp[];

    // Drift check against the CURRENT board, not the board as it was at propose.
    // STALE means exactly this: the board moved under the approved preview, so
    // re-proposing (not retrying) is the human's correct next step. An
    // execution failure inside the transaction below is a different event —
    // see the catch block's FAILED code — with a different remedy: retry.
    const facts = await loadBoardFacts(this.prisma, cs.boardId);
    const errors = validateOps(ops, facts);
    if (errors.length > 0) {
      await this.prisma.advisorChangeSet.update({ where: { id }, data: { status: 'STALE' } });
      return { ok: false, code: 'STALE', errors };
    }

    try {
      await this.prisma.$transaction(
        async (tx) => {
          // op index → created group id, for resolving "$n" targets.
          const created = new Map<number, string>();

          for (let i = 0; i < ops.length; i++) {
            const op = ops[i]!;
            switch (op.op) {
              case 'create_group': {
                // Bottom-of-board position, exactly as `GroupService.create`
                // computes it — `Group.position` is `Int @default(0)`, and
                // groups are read `orderBy: { position: 'asc' }` everywhere,
                // including by the Advisor's own `get_board_structure`. Left to
                // the default, "create a group and move rows into it" — the
                // primary use case — produced a group tied at 0 with whatever
                // was already there, ordering resolved arbitrarily, and two
                // `create_group` ops in one change-set both landed at 0.
                //
                // Same defect class as `move_rows`'s stale `order` below, one
                // case over. Counted INSIDE the transaction and per op, so the
                // second `create_group` sees the first one's row and cannot tie
                // with it.
                const position = await tx.group.count({ where: { boardId: cs.boardId } });
                const group = await tx.group.create({
                  data: { name: op.name, boardId: cs.boardId, position },
                });
                created.set(i, group.id);
                break;
              }
              case 'move_rows': {
                const ref = parseOpRef(op.targetGroupId);
                const groupId = ref === null ? op.targetGroupId : created.get(ref);
                // Unreachable if validation is correct; throwing rather than
                // silently skipping keeps a validator bug from moving rows nowhere.
                if (!groupId) throw new Error(`unresolved targetGroupId for op ${i}`);
                // Bottom-of-group order, same idea as
                // ProjectService.moveProjectToBoard's nextBottomOrder: without
                // this, a moved row keeps whatever `order` it held in its OLD
                // group, which can land anywhere among the target group's
                // existing rows instead of at the bottom — arbitrary
                // placement on the one action this feature exists to make
                // predictable. All rows in this op share one order value
                // (ties break on createdAt, then id — see
                // ProjectService.list's orderBy — so this is deterministic,
                // just not individually ordered within the batch).
                const bottom = await tx.project.aggregate({
                  where: { groupId },
                  _max: { order: true },
                });
                const order = (bottom._max.order ?? 0) + 1;
                const result = await tx.project.updateMany({
                  where: { id: { in: op.rowIds }, boardId: cs.boardId },
                  data: { groupId, order },
                });
                if (result.count !== op.rowIds.length) {
                  throw new Error(`op ${i}: expected to move ${op.rowIds.length} rows, moved ${result.count}`);
                }
                break;
              }
              case 'set_fields': {
                for (const rowId of op.rowIds) {
                  await this.applySetFields(tx, rowId, cs.boardId, cs.createdByUserId, op.patch);
                }
                break;
              }
            }
            await this._afterOp?.(i);
          }

          // A conditional update, not a blind one — this is the only thing
          // standing between "cannot apply twice" and a real race. Two
          // concurrent apply() calls for the same change-set both pass the
          // :PENDING check above (it runs before either transaction opens),
          // both open a transaction, and Postgres serializes them on this
          // row: the loser's UPDATE blocks until the winner commits, then
          // re-evaluates `status = 'PENDING'` against a row the winner just
          // flipped to APPLIED. `updateMany` + `count === 0` makes that
          // re-evaluation the actual guard instead of trusting the read at
          // the top of `apply()` to still be true minutes (or microseconds)
          // later. Same shape as ChangeSetService.discard's
          // count-based refusal — one pattern for "conditional terminal
          // write," not two.
          const applied = await tx.advisorChangeSet.updateMany({
            // Same four predicates as `getForApply` above, plus the status —
            // one predicate set, stated once per statement, so the terminal
            // write can never be broader than the read that authorized it.
            where: { id, boardId, organizationId, createdByUserId: userId, status: 'PENDING' },
            data: { status: 'APPLIED', appliedAt: new Date() },
          });
          if (applied.count === 0) {
            throw new Error(
              'change-set was no longer PENDING when the transaction tried to commit (concurrent apply)',
            );
          }
        },
        { timeout: APPLY_TIMEOUT_MS, maxWait: APPLY_MAX_WAIT_MS },
      );
    } catch (err) {
      // Nothing committed. The change-set stays PENDING so the human can retry
      // after whatever caused the failure is resolved, rather than losing it.
      // FAILED, not STALE: the board did not necessarily drift — the drift
      // check above already passed — something went wrong executing an op
      // that validation said was safe (a validator bug, a race after the
      // drift check, an unsupported patch key, a lost race against a
      // concurrent apply). Conflating the two would tell the human
      // "re-propose" when the correct instruction is "retry".
      //
      // This is the only code in the stage that writes to a board; a bare
      // `catch {}` here would mean an operator sees FAILED with no way to
      // tell a validator bug from a lost race from a genuine data problem.
      // Tagged console.error, matching the house style at
      // project.service.ts:504-513 for a non-fatal, already-rolled-back
      // failure that still needs to reach ops logs.
      console.error('[change-set-apply.service] apply failed, transaction rolled back', {
        changeSetId: id,
        error: err,
      });
      return { ok: false, code: 'FAILED' };
    }

    return { ok: true, applied: ops.length };
  }

  /**
   * Per-row field write, inside the transaction, through the SAME service the
   * board UI calls.
   *
   * The trick that makes one write path possible: `ProjectService` holds its
   * client in the constructor and `update()` contains no nested `$transaction`,
   * so a service instance constructed around the transaction client behaves
   * identically and enlists in this transaction. That is why this is a cast and
   * not a refactor. Both facts were re-confirmed against this checkout before
   * relying on them (see task-6-report.md).
   *
   * Going through `update()` is not a convenience — it is the correctness
   * requirement. `update()` is what calls `markOverridden`, captures the
   * pre-edit value for a later revert, and derives the legacy `status` enum from
   * the board-status label. A bare `tx.project.update` here would skip all
   * three: the row would keep tracking its sync source (making the preview's
   * override note a lie), lose its revert snapshot, and end up with `statusId`
   * and `status` disagreeing, which breaks board filters and automations.
   *
   * The board-membership check below is the `set_fields` analogue of
   * `move_rows`'s `where: { boardId: cs.boardId }` — `move_rows` proves board
   * membership at the SQL statement that writes; this op didn't, because
   * `ProjectService.update` takes only a bare row id and updates by primary
   * key alone. Board membership was proven once, by the pre-transaction
   * validator, and nothing re-checked it here — a TOCTOU window between that
   * check and this write, not hypothetical:
   * `ProjectService.moveProjectToBoard` relocates rows between boards, and
   * boards belong to different organizations. Asymmetric guarantees inside
   * one switch statement was the defect; this closes it the same way
   * `move_rows` already does.
   *
   * `patch` is picked field-by-field rather than forwarded whole, and anything
   * outside the four keys below throws instead of being passed through
   * silently. This used to be live defence: `set_fields`'s schema accepted
   * `assignee`, a key `ProjectService.update` has never written, which would
   * have type-checked (TypeScript widens rather than rejects an extra
   * property on a non-literal value) and then silently no-op'd at runtime —
   * exactly the "approved but not what happened" failure this class exists to
   * prevent. `assignee` is gone from the schema now (Task 2,
   * packages/shared/src/advisor-change-set.ts — `Project.assignee` is the
   * sync writers' identity column, not a board-editable field, and the
   * schema now rejects it with `.strict()` even in a mixed patch), so today
   * this throw is unreachable for any input the schema itself allows. It
   * stays as defence against the schema being widened again without a
   * matching write path being added here — the failure mode it guards
   * against is a future one, not a current one.
   */
  private async applySetFields(
    tx: Prisma.TransactionClient,
    rowId: string,
    boardId: string,
    userId: string,
    patch: Extract<BoardOp, { op: 'set_fields' }>['patch'],
  ): Promise<void> {
    const onBoard = await tx.project.findFirst({ where: { id: rowId, boardId }, select: { id: true } });
    if (!onBoard) throw new Error(`row ${rowId} is not on board ${boardId}`);

    const unsupported = Object.keys(patch).filter(
      (key) => key !== 'name' && key !== 'description' && key !== 'statusId' && key !== 'owner',
    );
    if (unsupported.length > 0) {
      throw new Error(
        `set_fields patch key(s) not supported by ProjectService.update: ${unsupported.join(', ')}`,
      );
    }
    const input: UpdateProjectInput = {
      ...(patch.name !== undefined && { name: patch.name }),
      // ProjectService.update writes `input.description` verbatim into a
      // nullable Prisma column, so `null` (an explicit clear) is a legitimate
      // runtime value here even though UpdateProjectInputSchema's inferred
      // type only names `string | undefined`.
      ...(patch.description !== undefined && {
        description: patch.description as string | undefined,
      }),
      ...(patch.statusId !== undefined && { statusId: patch.statusId }),
      ...(patch.owner !== undefined && { owner: patch.owner }),
    };

    const projects = new ProjectService(tx as unknown as PrismaClient);
    const updated = await projects.update(rowId, input, userId);
    // `update` returns null for a row it could not find. Validation already
    // proved the row is on this board, so null here means it vanished between
    // the drift check and now — throw to roll the whole change-set back rather
    // than reporting a partial success.
    if (!updated) throw new Error(`row ${rowId} disappeared during apply`);
  }
}
