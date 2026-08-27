// Attaching a Jira field to a board means two writes that must both land or
// neither: create the BoardColumn, and record the field → column mapping on the
// source. A partial success leaves either an orphan column the user did not ask
// for, or a mapping pointing at a column id that does not exist — and the
// second makes every subsequent sync upsert against a missing FK.
//
// `organizationId` leads the parameter list for the same reason it does in
// SourceFieldsService: a mis-ordered call should fail to compile, not become a
// tenant bypass. `boardId` is checked against the loaded source row so a caller
// with access to board A cannot mutate a source attached to board B.

import type { PrismaClient } from '@deckgauge/db';
import type { AttachJiraFieldInput } from '@deckgauge/shared';

export class SyncedColumnSourceNotFoundError extends Error {
  constructor(id: string) {
    super(`jira source ${id} not found`);
    this.name = 'SyncedColumnSourceNotFoundError';
  }
}

export class FieldAlreadyMappedError extends Error {
  constructor(fieldId: string) {
    super(`field ${fieldId} is already mapped on this source`);
    this.name = 'FieldAlreadyMappedError';
  }
}

interface Deps {
  prisma: PrismaClient;
}

export class SyncedColumnService {
  private readonly deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  async attachJiraField(
    _organizationId: string,
    boardId: string,
    boardJiraSourceId: string,
    input: AttachJiraFieldInput,
  ): Promise<{ columnId: string }> {
    return this.deps.prisma.$transaction(async (tx) => {
      const row = await tx.boardJiraSource.findUnique({
        where: { id: boardJiraSourceId },
      });
      if (!row || row.boardId !== boardId) {
        throw new SyncedColumnSourceNotFoundError(boardJiraSourceId);
      }

      const mappings = (row.fieldMappings ?? {}) as Record<string, string>;
      if (mappings[input.fieldId]) {
        throw new FieldAlreadyMappedError(input.fieldId);
      }

      const last = await tx.boardColumn.findFirst({
        where: { boardId },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      const nextOrder = last ? last.order + 1 : 0;

      const column = await tx.boardColumn.create({
        data: {
          boardId,
          name: input.name,
          type: input.columnType,
          order: nextOrder,
          // Marks the column as sync-derived, and records whether its values are
          // a joined list. The renderer chips ONLY when `multiValue` is true —
          // without this flag it would have to split every TEXT cell, turning a
          // hand-typed "a, b" in an ordinary column into two chips.
          config: { jiraFieldId: input.fieldId, multiValue: input.multiValue },
        },
      });

      await tx.boardJiraSource.update({
        where: { id: boardJiraSourceId },
        data: { fieldMappings: { ...mappings, [input.fieldId]: column.id } },
      });

      return { columnId: column.id };
    });
  }

  /**
   * Removes the mapping only. The column and its values stay, becoming ordinary
   * manual data — detaching a source should not destroy work the board is
   * showing. Deleting the column is a separate action.
   */
  async detachJiraField(
    _organizationId: string,
    boardId: string,
    boardJiraSourceId: string,
    fieldId: string,
  ): Promise<boolean> {
    return this.deps.prisma.$transaction(async (tx) => {
      const row = await tx.boardJiraSource.findUnique({
        where: { id: boardJiraSourceId },
      });
      if (!row || row.boardId !== boardId) {
        throw new SyncedColumnSourceNotFoundError(boardJiraSourceId);
      }

      const mappings = (row.fieldMappings ?? {}) as Record<string, string>;
      if (!mappings[fieldId]) return false;

      const next = { ...mappings };
      delete next[fieldId];

      await tx.boardJiraSource.update({
        where: { id: boardJiraSourceId },
        data: { fieldMappings: next },
      });

      return true;
    });
  }
}
