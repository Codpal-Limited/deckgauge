import { buildClassificationRow, type ClassifiableRow } from '../projects/classification-mirror.js';

export interface BackfillDeps {
  listClassifiedProjects: () => Promise<ClassifiableRow[]>;
  insert: (table: string, rows: unknown[]) => Promise<void>;
}

/** Mirror every sourced+classified Project into board_item_classification. Idempotent (ReplacingMergeTree). */
export async function backfillClassificationMirror(
  deps: BackfillDeps,
): Promise<{ scanned: number; mirrored: number }> {
  const projects = await deps.listClassifiedProjects();
  const rows = projects.map(buildClassificationRow).filter((r): r is NonNullable<typeof r> => r !== null);
  if (rows.length > 0) {
    await deps.insert('board_item_classification', rows);
  }
  return { scanned: projects.length, mirrored: rows.length };
}

async function runFromCli(): Promise<void> {
  const { PrismaClient, chInsertMany } = await import('@deckgauge/db');
  const prisma = new PrismaClient();
  try {
    // Connections are an organization property now, and this CLI script has
    // no request to take an organization from. Under the enforced
    // single-organization cap there is at most one, so resolving it here is
    // unambiguous (same reasoning as the worker's bootstrapAdoFromYaml).
    const organization = await prisma.organization.findFirst({ select: { id: true } });
    if (!organization) {
      throw new Error(
        'backfill-classification-mirror: no organization exists yet — there is no tenant to mirror rows into',
      );
    }
    const result = await backfillClassificationMirror({
      listClassifiedProjects: () =>
        prisma.project.findMany({
          where: { costClassification: { not: null } },
          select: {
            id: true,
            boardId: true,
            jiraKey: true,
            adoWorkItemId: true,
            adoProject: true,
            githubIssueId: true,
            costClassification: true,
          },
        }) as Promise<ClassifiableRow[]>,
      // organizationId is bound here by closure, not threaded through
      // BackfillDeps — matches the bind-not-pass pattern used for the
      // worker's chClientFor.
      insert: (table, rows) => chInsertMany(table, organization.id, rows as Record<string, unknown>[]),
    });
    console.log(`Backfill complete: scanned ${result.scanned}, mirrored ${result.mirrored}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  runFromCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
