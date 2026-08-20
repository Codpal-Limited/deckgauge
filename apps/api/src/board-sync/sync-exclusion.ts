/**
 * Recording a `BoardSyncExclusion` is what makes a deleted synced row stay
 * deleted: every promote service filters these keys out of all future syncs.
 *
 * Two delete paths reach it — deleting rows (project.service) and deleting a
 * group, whose rows cascade away in Postgres (`Project.group` is
 * `onDelete: Cascade`). Both must record the same shape, so the derivation
 * lives here rather than in either caller.
 */

export interface SyncExclusionInput {
  boardId: string;
  source: 'ADO' | 'GITHUB' | 'JIRA';
  externalId: string;
  excludedBy: string | null;
}

/** The fields a row must carry for its exclusion to be derivable. */
export interface DeletableRow {
  boardId: string | null;
  adoWorkItemId: number | null;
  githubIssueId: string | null;
  jiraKey: string | null;
}

/** Prisma `select` that yields exactly a {@link DeletableRow}. */
export const SYNC_EXCLUSION_SELECT = {
  boardId: true,
  adoWorkItemId: true,
  githubIssueId: true,
  jiraKey: true,
} as const;

/**
 * Postgres caps a statement at 65535 bind parameters and each exclusion binds
 * four, so a single createMany over a large group would fail outright.
 */
const CHUNK_SIZE = 1000;

/** Just the slice of a Prisma client (or transaction) this module writes through. */
interface ExclusionWriter {
  boardSyncExclusion: {
    createMany(args: {
      data: SyncExclusionInput[];
      skipDuplicates?: boolean;
    }): Promise<unknown>;
  };
}

/**
 * Derive the exclusion for a row being deleted. Returns null for native rows
 * (no source) and for rows with no board — exclusions are board-scoped.
 */
export function toSyncExclusion(row: DeletableRow, userId?: string): SyncExclusionInput | null {
  if (!row.boardId) return null;
  const excludedBy = userId ?? null;
  if (row.adoWorkItemId != null) {
    return { boardId: row.boardId, source: 'ADO', externalId: String(row.adoWorkItemId), excludedBy };
  }
  if (row.githubIssueId != null) {
    return { boardId: row.boardId, source: 'GITHUB', externalId: row.githubIssueId, excludedBy };
  }
  if (row.jiraKey != null) {
    return { boardId: row.boardId, source: 'JIRA', externalId: row.jiraKey, excludedBy };
  }
  return null;
}

/** {@link toSyncExclusion} over a batch, dropping the rows that have no source. */
export function toSyncExclusions(rows: DeletableRow[], userId?: string): SyncExclusionInput[] {
  return rows
    .map((row) => toSyncExclusion(row, userId))
    .filter((e): e is SyncExclusionInput => e !== null);
}

/**
 * Write the exclusions in bounded chunks. Duplicates are skipped, so deleting
 * a key that is already excluded is a no-op rather than an error.
 */
export async function recordSyncExclusions(
  tx: ExclusionWriter,
  exclusions: SyncExclusionInput[],
): Promise<void> {
  for (let i = 0; i < exclusions.length; i += CHUNK_SIZE) {
    await tx.boardSyncExclusion.createMany({
      data: exclusions.slice(i, i + CHUNK_SIZE),
      skipDuplicates: true,
    });
  }
}
