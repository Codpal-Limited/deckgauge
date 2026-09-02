import type { PrismaClient } from '@deckgauge/db';
import { parseOpRef, type BoardOp } from '@deckgauge/shared';

export interface ValidationError {
  opIndex: number;
  reason: string;
}

/**
 * Everything about a board that validation needs, loaded once.
 *
 * Sets rather than counts: every id an op names has to be proven a member of
 * THIS board. The model chose those ids, so from the server's point of view
 * they are untrusted input — "the caller may edit board X" does not make an id
 * from board Y actionable.
 */
export interface BoardFacts {
  groupIds: Set<string>;
  statusIds: Set<string>;
  rowIds: Set<string>;
}

export async function loadBoardFacts(
  prisma: PrismaClient,
  boardId: string,
): Promise<BoardFacts> {
  const [groups, statuses, rows] = await Promise.all([
    prisma.group.findMany({ where: { boardId }, select: { id: true } }),
    prisma.boardStatus.findMany({ where: { boardId }, select: { id: true } }),
    prisma.project.findMany({ where: { boardId }, select: { id: true } }),
  ]);
  return {
    groupIds: new Set(groups.map((g) => g.id)),
    statusIds: new Set(statuses.map((s) => s.id)),
    rowIds: new Set(rows.map((r) => r.id)),
  };
}

/**
 * Pure validation of an op list against a board's facts.
 *
 * Returns EVERY error rather than the first: a model correcting one rejection at
 * a time burns a round trip per mistake, and the whole list is cheap to check.
 */
export function validateOps(ops: BoardOp[], facts: BoardFacts): ValidationError[] {
  const errors: ValidationError[] = [];
  const add = (opIndex: number, reason: string) => errors.push({ opIndex, reason });

  const checkRows = (opIndex: number, rowIds: string[]) => {
    if (new Set(rowIds).size !== rowIds.length) {
      add(opIndex, 'rowIds contains duplicate ids');
    }
    const missing = rowIds.filter((id) => !facts.rowIds.has(id));
    if (missing.length > 0) {
      add(opIndex, `${missing.length} row id(s) are not on this board: ${missing.slice(0, 5).join(', ')}`);
    }
  };

  const checkGroupTarget = (opIndex: number, target: string) => {
    const ref = parseOpRef(target);
    if (ref === null) {
      if (!facts.groupIds.has(target)) {
        add(opIndex, `targetGroupId ${target} is not on this board`);
      }
      return;
    }
    // Existence is checked before direction: a ref past the end of the ops
    // array is "no such op" regardless of whether it also happens to be
    // forward, and that message is more useful than a direction complaint.
    const referenced = ops[ref];
    if (!referenced) {
      add(opIndex, `targetGroupId "$${ref}" references no op ${ref}`);
      return;
    }
    // A reference must point strictly backwards: apply resolves ops in order, so
    // a forward or self reference has no value to resolve to at execution time.
    if (ref >= opIndex) {
      add(opIndex, `targetGroupId "$${ref}" must reference an earlier op`);
      return;
    }
    if (referenced.op !== 'create_group') {
      add(opIndex, `targetGroupId "$${ref}" references op ${ref}, which does not create a group`);
    }
  };

  ops.forEach((op, i) => {
    switch (op.op) {
      case 'create_group':
        break; // name shape is already guaranteed by the schema
      case 'move_rows':
        checkRows(i, op.rowIds);
        checkGroupTarget(i, op.targetGroupId);
        break;
      case 'set_fields':
        checkRows(i, op.rowIds);
        if (op.patch.statusId !== undefined && !facts.statusIds.has(op.patch.statusId)) {
          add(i, `patch.statusId ${op.patch.statusId} is not on this board`);
        }
        break;
    }
  });

  return errors;
}
