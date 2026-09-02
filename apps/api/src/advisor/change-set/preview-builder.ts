import type { PrismaClient } from '@deckgauge/db';
import {
  parseOpRef,
  type AdvisorChangeSetPreviewDto,
  type AdvisorChangeSetPreviewRowDto,
  type BoardOp,
} from '@deckgauge/shared';

export interface PreviewRow {
  id: string;
  name: string;
  groupId: string | null;
  statusId: string | null;
  /** From `Project.overriddenFields` — fields already detached from sync. */
  overriddenFields: string[];
}

export interface PreviewContext {
  rows: Map<string, PreviewRow>;
  groupNames: Map<string, string>;
  statusLabels: Map<string, string>;
  /** Field keys any connected source is configured to write on this board. */
  syncOwned: Set<string>;
}

export async function loadPreviewContext(
  prisma: PrismaClient,
  boardId: string,
  rowIds: string[],
): Promise<PreviewContext> {
  const [rows, groups, statuses, jira, github, ado] = await Promise.all([
    prisma.project.findMany({
      where: { boardId, id: { in: rowIds } },
      select: { id: true, name: true, groupId: true, statusId: true, overriddenFields: true },
    }),
    prisma.group.findMany({ where: { boardId }, select: { id: true, name: true } }),
    prisma.boardStatus.findMany({ where: { boardId }, select: { id: true, label: true } }),
    prisma.boardJiraSource.findMany({ where: { boardId }, select: { defaultSyncedFields: true } }),
    prisma.boardGitHubSource.findMany({ where: { boardId }, select: { defaultSyncedFields: true } }),
    prisma.boardAdoSource.findMany({ where: { boardId }, select: { defaultSyncedFields: true } }),
  ]);

  const syncOwned = new Set<string>();
  // Jira stores this as Json (which can hold a non-array), GitHub/ADO as String[].
  for (const list of [...jira, ...github, ...ado].map((s) => s.defaultSyncedFields)) {
    if (Array.isArray(list)) for (const f of list) if (typeof f === 'string') syncOwned.add(f);
  }

  return {
    rows: new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          name: r.name,
          groupId: r.groupId,
          statusId: r.statusId,
          overriddenFields: Array.isArray(r.overriddenFields) ? (r.overriddenFields as string[]) : [],
        },
      ]),
    ),
    groupNames: new Map(groups.map((g) => [g.id, g.name])),
    statusLabels: new Map(statuses.map((s) => [s.id, s.label])),
    syncOwned,
  };
}

/**
 * Turns an op list into the row-level diff a human approves.
 *
 * Pure and synchronous: everything it needs is in `PreviewContext`, which keeps
 * it exhaustively testable and keeps the "what will this do" logic out of the
 * database round trips.
 *
 * A no-op is deliberately omitted rather than rendered as an unchanged line. A
 * preview that lists forty rows when only three actually change misrepresents
 * the blast radius, which is the one thing the human is being asked to judge.
 */
export function buildPreview(ops: BoardOp[], ctx: PreviewContext): AdvisorChangeSetPreviewDto {
  const createdGroups: { opIndex: number; name: string }[] = [];
  const perRow = new Map<string, string[]>();
  const opSummaries: string[] = [];
  const overrideFields = new Set<string>();
  let truncated = false;

  // A group target is either a real group id or a `$N` reference to an earlier
  // create_group op. Resolved once into (name, isNew) so the two places that
  // render it — the per-row "from → to" line and the op summary line — can
  // each format the "(new)" marker in their own idiom instead of sharing one
  // pre-quoted string.
  const resolveGroupTarget = (target: string): { name: string; isNew: boolean } => {
    const ref = parseOpRef(target);
    if (ref !== null) {
      const created = ops[ref];
      const name = created && created.op === 'create_group' ? created.name : `op ${ref}`;
      return { name, isNew: true };
    }
    return { name: ctx.groupNames.get(target) ?? target, isNew: false };
  };

  const note = (rowId: string, line: string) => {
    const list = perRow.get(rowId) ?? [];
    list.push(line);
    perRow.set(rowId, list);
  };

  ops.forEach((op, i) => {
    switch (op.op) {
      case 'create_group': {
        createdGroups.push({ opIndex: i, name: op.name });
        opSummaries.push(`Create group "${op.name}"`);
        break;
      }
      case 'move_rows': {
        const { name: groupName, isNew } = resolveGroupTarget(op.targetGroupId);
        const label = isNew ? `${groupName} (new)` : groupName;
        // Effective rows first, summary second: the op summary must count what
        // actually moves, not what was merely targeted — a `move_rows` whose
        // rows are already in the target group changes nothing, and a summary
        // saying otherwise is the same misrepresentation the row list is
        // careful to avoid, just one layer up.
        const changed: PreviewRow[] = [];
        for (const id of op.rowIds) {
          const row = ctx.rows.get(id);
          if (!row) { truncated = true; continue; }
          if (!isNew && row.groupId === op.targetGroupId) continue; // already there
          changed.push(row);
        }
        if (changed.length > 0) {
          opSummaries.push(
            `Move ${changed.length} row${changed.length === 1 ? '' : 's'} into "${groupName}"${
              isNew ? ' (new)' : ''
            }`,
          );
        }
        for (const row of changed) {
          const from = row.groupId ? (ctx.groupNames.get(row.groupId) ?? row.groupId) : '(none)';
          note(row.id, `group: ${from} → ${label}`);
        }
        break;
      }
      case 'set_fields': {
        const fields = Object.keys(op.patch);
        // Same principle as move_rows: count rows that actually change, not
        // op.rowIds.length, and omit the summary line entirely when nothing
        // in this op's patch changed any targeted row.
        let changedRowCount = 0;
        for (const id of op.rowIds) {
          const row = ctx.rows.get(id);
          if (!row) { truncated = true; continue; }
          let rowChanged = false;
          if (op.patch.statusId !== undefined) {
            if (row.statusId !== op.patch.statusId) {
              const from = row.statusId ? (ctx.statusLabels.get(row.statusId) ?? row.statusId) : '(none)';
              const to = ctx.statusLabels.get(op.patch.statusId) ?? op.patch.statusId;
              note(id, `status: ${from} → ${to}`);
              rowChanged = true;
              if (ctx.syncOwned.has('status') && !row.overriddenFields.includes('status')) {
                overrideFields.add('status');
              }
            }
          }
          for (const key of ['name', 'description', 'owner'] as const) {
            const next = op.patch[key];
            if (next === undefined) continue;
            // `name` is the one free-text field whose current value is already
            // in PreviewContext, so it gets a real no-op check like status/group.
            // description/owner are never loaded (see PreviewRow) — that is the
            // documented, intentional limit on this task's scope — so they
            // render as "changed" whenever the op touches them at all.
            if (key === 'name' && next === row.name) continue;
            note(id, `${key}: changed`);
            rowChanged = true;
            if (ctx.syncOwned.has(key) && !row.overriddenFields.includes(key)) {
              overrideFields.add(key);
            }
          }
          if (rowChanged) changedRowCount++;
        }
        if (changedRowCount > 0) {
          opSummaries.push(
            `Set ${fields.join(', ')} on ${changedRowCount} row${changedRowCount === 1 ? '' : 's'}`,
          );
        }
        break;
      }
    }
  });

  const rows: AdvisorChangeSetPreviewRowDto[] = [];
  for (const [rowId, changes] of perRow) {
    if (changes.length === 0) continue;
    rows.push({ rowId, rowName: ctx.rows.get(rowId)?.name ?? rowId, changes });
  }

  const overrideNotes = [...overrideFields].map(
    (f) =>
      `A source on this board is configured to sync "${f}". Applying this records a manual override, ` +
      `so the field will no longer be overwritten by sync — the row stops tracking the source for ` +
      `"${f}" until the edit is reverted.`,
  );

  return { opSummaries, rows, createdGroups, overrideNotes, truncated };
}

export function summarize(preview: AdvisorChangeSetPreviewDto): string {
  const ops = preview.opSummaries.length;
  const rows = preview.rows.length;
  return `${ops} change${ops === 1 ? '' : 's'} affecting ${rows} row${rows === 1 ? '' : 's'}`;
}
