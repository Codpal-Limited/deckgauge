import type { PrismaClient, AdvisorChangeSet, Prisma } from '@deckgauge/db';
import { MAX_TOTAL_ROWS_PER_CHANGE_SET, type AdvisorChangeSetDto, type BoardOp } from '@deckgauge/shared';
import { loadBoardFacts, validateOps, type ValidationError } from './op-validator.js';
import { buildPreview, loadPreviewContext, summarize } from './preview-builder.js';

/** How long a proposal stays applicable. Long enough to review, short enough that a stale preview expires rather than lingering. */
export const CHANGE_SET_TTL_MS = 60 * 60 * 1000;

export type ProposeResult =
  | { ok: true; changeSet: AdvisorChangeSetDto }
  | { ok: false; errors: ValidationError[] };

function rowIdsOf(ops: BoardOp[]): string[] {
  const ids = new Set<string>();
  for (const op of ops) if (op.op !== 'create_group') for (const id of op.rowIds) ids.add(id);
  return [...ids];
}

// The literal sum of every op's rowIds.length — deliberately NOT deduped like
// rowIdsOf above. MAX_ROWS_PER_OP bounds one op; without a total, a
// MAX_OPS_PER_CHANGE_SET-sized change-set with every op at the per-op cap
// still reaches ~25,000 sequential writes in the apply transaction, which no
// fixed timeout survives. The total counts each targeted row once per op
// that touches it, because that's what the apply transaction actually pays
// for — a row named by two different ops costs two writes, not one.
function totalRowIdCount(ops: BoardOp[]): number {
  return ops.reduce((sum, op) => sum + (op.op === 'create_group' ? 0 : op.rowIds.length), 0);
}

/**
 * Creates and reads Advisor change-sets.
 *
 * Every read is scoped by FOUR predicates — id, `boardId`, `organizationId`, and
 * `createdByUserId`. The organization is the tenant boundary; the creator is the
 * ownership rule: you approve the preview YOU were shown, so a change-set is not
 * a shared artifact even between two people who can both edit the board.
 *
 * `boardId` is the newest of the four and is NOT a fourth authorization axis: it
 * joins the other three on the SAME row, so the board the route authorized and
 * the board the change-set writes to must be one board. Without it the apply
 * route proved `EDITOR` on `req.params.boardId` while every write inside the
 * transaction targeted `cs.boardId` — two values that were never compared. A
 * caller who was EDITOR on board A and VIEWER on board B could propose against B
 * (see `buildAdvisorTools`/`registerBoardTools`) and then apply it through
 * `POST /boards/A/.../apply`; it also let a caller whose EDITOR on B was revoked
 * between propose and apply keep applying by naming board A in the URL. A
 * mismatch now matches no row, so the route answers 404 — the same answer as a
 * made-up id, because whether an id exists is not the caller's information.
 *
 * Nothing here applies a change-set. That is `ChangeSetApplyService`, reachable
 * only from an authenticated route — never from a tool.
 */
export class ChangeSetService {
  constructor(private readonly prisma: PrismaClient) {}

  async propose(args: {
    boardId: string;
    organizationId: string;
    userId: string;
    ops: BoardOp[];
  }): Promise<ProposeResult> {
    const facts = await loadBoardFacts(this.prisma, args.boardId);
    const errors = validateOps(args.ops, facts);

    // Enforced here, at propose time, rather than in validateOps: this is a
    // property of the WHOLE set (a sum across ops), not of any single op, so
    // it doesn't fit validateOps's per-op error shape naturally, and it's the
    // one check that must never be skipped regardless of how many other op
    // errors exist. opIndex: -1 marks it as concerning the change-set as a
    // whole rather than one op — there is no single op to point a caller at.
    const totalRows = totalRowIdCount(args.ops);
    if (totalRows > MAX_TOTAL_ROWS_PER_CHANGE_SET) {
      errors.push({
        opIndex: -1,
        reason: `change-set targets ${totalRows} row(s) across all ops, over the ${MAX_TOTAL_ROWS_PER_CHANGE_SET} total-row cap`,
      });
    }

    // Nothing is written on a rejection: a persisted invalid proposal would be a
    // row nobody can apply, cluttering the caller's pending list.
    if (errors.length > 0) return { ok: false, errors };

    const ctx = await loadPreviewContext(this.prisma, args.boardId, rowIdsOf(args.ops));
    const preview = buildPreview(args.ops, ctx);
    const row = await this.prisma.advisorChangeSet.create({
      data: {
        boardId: args.boardId,
        organizationId: args.organizationId,
        createdByUserId: args.userId,
        status: 'PENDING',
        summary: summarize(preview),
        ops: args.ops as unknown as Prisma.InputJsonValue,
        preview: preview as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + CHANGE_SET_TTL_MS),
      },
    });
    return { ok: true, changeSet: this.toDto(row) };
  }

  async listPending(
    boardId: string,
    organizationId: string,
    userId: string,
  ): Promise<AdvisorChangeSetDto[]> {
    const rows = await this.prisma.advisorChangeSet.findMany({
      where: {
        boardId,
        organizationId,
        createdByUserId: userId,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  /**
   * The row itself, not a DTO — the applier needs the raw op list.
   *
   * `boardId` is the board the ROUTE authorized (`req.params.boardId`), not the
   * board recorded on the change-set. That is the whole point: the two must be
   * the same row or there is no row.
   */
  async getForApply(
    id: string,
    boardId: string,
    organizationId: string,
    userId: string,
  ): Promise<AdvisorChangeSet | null> {
    return this.prisma.advisorChangeSet.findFirst({
      where: { id, boardId, organizationId, createdByUserId: userId },
    });
  }

  /** `boardId` is the route-authorized board — see `getForApply`. */
  async discard(
    id: string,
    boardId: string,
    organizationId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await this.prisma.advisorChangeSet.updateMany({
      where: { id, boardId, organizationId, createdByUserId: userId, status: 'PENDING' },
      data: { status: 'DISCARDED' },
    });
    return result.count > 0;
  }

  private toDto(row: AdvisorChangeSet): AdvisorChangeSetDto {
    return {
      id: row.id,
      boardId: row.boardId,
      status: row.status as AdvisorChangeSetDto['status'],
      summary: row.summary,
      ops: row.ops as unknown as BoardOp[],
      preview: row.preview as unknown as AdvisorChangeSetDto['preview'],
      expiresAt: row.expiresAt.toISOString(),
      appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
