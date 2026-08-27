import type { PrismaClient } from '@deckgauge/db';
import {
  evaluateAutomations,
  loadEnabledRules,
  type AutomationChanges,
  type AutomationRuleRow,
} from '@deckgauge/automations';

/**
 * Runs a board's automation rules against the rows a SYNC writes.
 *
 * A sync changes statuses on exactly the rows a person does, so a rule that only
 * fires for hand-edits is indistinguishable from a broken rule. The engine itself
 * is shared with the API (`@deckgauge/automations`); what lives here is the part
 * that is specific to running it over a whole sync:
 *
 *  - Rules and the board's organization are read ONCE per board per run, not once
 *    per row. A 500-issue sync would otherwise be 500 identical queries.
 *  - A board with no enabled rules costs one query and then nothing at all.
 *  - Nothing here may throw. The rows are already committed and a broken rule must
 *    never fail the sync that wrote them.
 *
 * `actorId` is always null: no person pressed anything. The dispatcher excludes the
 * actor from recipients, so a null actor excludes nobody — correct here, because
 * whoever moved the ticket upstream is not acting inside Deckgauge.
 */

interface BoardAutomationState {
  rules: AutomationRuleRow[];
  organizationId: string | null;
}

export interface SyncAutomationInput {
  boardId: string;
  projectId: string;
  changes: AutomationChanges;
}

export interface SyncAutomationRunner {
  run(input: SyncAutomationInput): Promise<void>;
}

export function createSyncAutomationRunner(prisma: PrismaClient): SyncAutomationRunner {
  const byBoard = new Map<string, Promise<BoardAutomationState>>();

  async function loadBoardState(boardId: string): Promise<BoardAutomationState> {
    const rules = await loadEnabledRules(prisma, boardId);
    // No rules means nothing can fire, so the board lookup is never worth making.
    if (rules.length === 0) return { rules, organizationId: null };

    const board = await prisma.board.findUnique({
      where: { id: boardId },
      select: { organizationId: true },
    });
    return { rules, organizationId: board?.organizationId ?? null };
  }

  function boardState(boardId: string): Promise<BoardAutomationState> {
    // The promise itself is cached, so concurrent rows on one board share a single
    // in-flight load rather than racing to issue the same two queries.
    const cached = byBoard.get(boardId);
    if (cached) return cached;
    const pending = loadBoardState(boardId);
    byBoard.set(boardId, pending);
    return pending;
  }

  return {
    async run(input: SyncAutomationInput): Promise<void> {
      try {
        const { rules, organizationId } = await boardState(input.boardId);
        if (rules.length === 0) return;

        await evaluateAutomations(
          prisma,
          {
            boardId: input.boardId,
            projectId: input.projectId,
            changes: input.changes,
            context: { actorId: null, organizationId },
          },
          { rules },
        );
      } catch (err) {
        console.error(
          `[SyncAutomations] Board ${input.boardId} row ${input.projectId}: rule evaluation ` +
            `failed — the synced row itself is unaffected.`,
          err,
        );
      }
    },
  };
}
