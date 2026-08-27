import type { PrismaClient } from "@deckgauge/db";
import type {
  BoardColumn,
  CreateColumnInput,
  UpdateColumnInput,
  FieldValue,
  UpsertFieldValueInput,
} from "@deckgauge/shared";
import { customColumnKey, markOverridden, readOverrideState } from "@deckgauge/shared";

/**
 * Returns a new fieldMappings object with every entry pointing at `columnId`
 * removed, or `null` if none did (so the caller can skip a no-op write).
 * Shared by the Jira and ADO source pruning loops in `delete` — both store
 * mappings in the same `Record<fieldId, columnId>` JSON shape.
 */
function pruneStaleMapping(
  fieldMappings: unknown,
  columnId: string,
): Record<string, string> | null {
  const mappings = (fieldMappings ?? {}) as Record<string, string>;
  const stale = Object.entries(mappings).filter(([, id]) => id === columnId);
  if (stale.length === 0) return null;

  const next = { ...mappings };
  for (const [fieldId] of stale) delete next[fieldId];
  return next;
}

export class ColumnService {
  constructor(private readonly prisma: PrismaClient) {}

  async listByBoard(boardId: string): Promise<BoardColumn[]> {
    const rows = await this.prisma.boardColumn.findMany({
      where: { boardId },
      orderBy: { order: "asc" },
    });
    return rows as BoardColumn[];
  }

  async create(boardId: string, input: CreateColumnInput): Promise<BoardColumn> {
    const existing = await this.prisma.boardColumn.findMany({
      where: { boardId },
      orderBy: { order: "desc" },
      take: 1,
    });
    const nextOrder = existing.length > 0 ? existing[0]!.order + 1 : 0;

    const row = await this.prisma.boardColumn.create({
      data: {
        boardId,
        name: input.name,
        type: input.type,
        order: nextOrder,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(input.config !== undefined && { config: input.config as unknown as any }),
      },
    });
    return row as BoardColumn;
  }

  async update(
    columnId: string,
    input: UpdateColumnInput,
  ): Promise<BoardColumn | null> {
    const existing = await this.prisma.boardColumn.findUnique({
      where: { id: columnId },
    });
    if (!existing) return null;

    const row = await this.prisma.boardColumn.update({
      where: { id: columnId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.order !== undefined && { order: input.order }),
      },
    });
    return row as BoardColumn;
  }

  async delete(columnId: string): Promise<boolean> {
    const existing = await this.prisma.boardColumn.findUnique({
      where: { id: columnId },
    });
    if (!existing) return false;

    await this.prisma.$transaction(async (tx) => {
      // A mapping left pointing at a deleted column makes every subsequent sync
      // (Jira AND ADO — both store this as the same boardId -> fieldMappings
      // shape) upsert a ProjectFieldValue against a missing FK.
      // ProjectFieldValue cascades on the column, but fieldMappings is JSON
      // and cascades nothing, on either source table.
      const jiraSources = await tx.boardJiraSource.findMany({
        where: { boardId: existing.boardId },
      });
      for (const source of jiraSources) {
        const next = pruneStaleMapping(source.fieldMappings, columnId);
        if (!next) continue;
        await tx.boardJiraSource.update({
          where: { id: source.id },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { fieldMappings: next as any },
        });
      }

      const adoSources = await tx.boardAdoSource.findMany({
        where: { boardId: existing.boardId },
      });
      for (const source of adoSources) {
        const next = pruneStaleMapping(source.fieldMappings, columnId);
        if (!next) continue;
        await tx.boardAdoSource.update({
          where: { id: source.id },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { fieldMappings: next as any },
        });
      }

      await tx.boardColumn.delete({ where: { id: columnId } });
    });

    return true;
  }

  async upsertFieldValues(
    projectId: string,
    inputs: UpsertFieldValueInput[],
  ): Promise<FieldValue[] | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) return null;

    const results = await this.prisma.$transaction(async (tx) => {
      // A manual edit of a synced column takes it over until the user reverts,
      // exactly as it does for Owner or Description. Sync consults these keys
      // via shouldSync(customColumnKey(columnId), ...). Read the current
      // values BEFORE upserting: after the upsert, what sync last wrote is gone.
      const existing = await tx.projectFieldValue.findMany({
        where: { projectId, columnId: { in: inputs.map((i) => i.columnId) } },
      });
      const previousByColumn = new Map(existing.map((v) => [v.columnId, v.value]));

      // Only SYNCED columns get an override key. A purely manual column has no
      // source value to diverge from, so marking it would grow overriddenFields
      // without bound and offer a "revert to synced value" affordance with
      // nothing behind it. overriddenFields means what sync-field-registry.ts
      // documents: a manual edit that took over a synced field.
      //
      // A boardless project (Project.boardId is nullable) must resolve zero
      // sources, not every source in the deployment. `where: { boardId:
      // undefined }` would REMOVE the filter rather than match null — Prisma
      // drops an undefined property instead of filtering on it — so the guard
      // has to keep the query from running at all rather than lean on the
      // where-clause to express "no board". Same hazard documented at
      // apps/worker/src/jira-jql-filter.ts:88-94.
      const sources = project.boardId
        ? await tx.boardJiraSource.findMany({
            where: { boardId: project.boardId },
            select: { fieldMappings: true },
          })
        : [];
      const syncedColumnIds = new Set(
        sources.flatMap((s) =>
          Object.values((s.fieldMappings ?? {}) as Record<string, string>),
        ),
      );

      const initialState = readOverrideState(project);
      let state = initialState;
      for (const input of inputs) {
        if (!syncedColumnIds.has(input.columnId)) continue;
        state = markOverridden(
          state,
          customColumnKey(input.columnId),
          previousByColumn.get(input.columnId) ?? null,
        );
      }

      // `project` was read OUTSIDE this transaction, so writing it
      // unconditionally risks reinstating a stale snapshot over a concurrent
      // ProjectService.update that touched overrides in between. Only write
      // when something was actually marked — markOverridden returns the SAME
      // reference on a no-op, so identity is a sufficient, cheap gate (same
      // pattern as the `overridesTouched` flag in project.service.ts:370).
      if (state !== initialState) {
        await tx.project.update({
          where: { id: projectId },
          data: {
            overriddenFields: state.overriddenFields,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            preOverrideValues: state.preOverrideValues as any,
          },
        });
      }

      return Promise.all(
        inputs.map((input) =>
          tx.projectFieldValue.upsert({
            where: {
              projectId_columnId: { projectId, columnId: input.columnId },
            },
            create: {
              projectId,
              columnId: input.columnId,
              value: input.value,
            },
            update: { value: input.value },
          }),
        ),
      );
    });

    return results as FieldValue[];
  }

  async getFieldValues(projectId: string): Promise<FieldValue[]> {
    const rows = await this.prisma.projectFieldValue.findMany({
      where: { projectId },
    });
    return rows as FieldValue[];
  }
}
