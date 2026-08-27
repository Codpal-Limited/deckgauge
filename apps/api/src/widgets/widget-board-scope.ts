// Widget-side board scope: the external project / repo identifiers that
// ClickHouse rows are tagged with, so board-scoped widget queries can filter
// against the global ClickHouse store.
//
// This used to be a second, independently maintained implementation, kept apart
// from `apps/api/src/intelligence/board-scope.ts` deliberately ("different path
// + namespace, to avoid merge conflicts"). The two drifted twice, and the second
// time it reached production: `adoProjectRefs` was added over there to stop two
// organisations' identically-named projects bleeding into one another, but
// every board dashboard resolves its scope through HERE — so the
// fix passed its tests and changed nothing on screen.
//
// It is now one function with a parameter. The only real difference between the
// two callers is that this one reads every attached source while the
// intelligence-query path honours `useForIntelligence`; that is expressed as
// `intelligenceOnly` and pinned by a test, rather than living in a second copy
// that nothing forces to agree.
import type { PrismaClient } from '@deckgauge/db';
import { resolveBoardScope, type ResolvedBoardScope } from '../intelligence/board-scope.js';

export type { AdoProdConfig } from '../intelligence/board-scope.js';

export type WidgetBoardScope = ResolvedBoardScope;

export async function getWidgetBoardScope(
  prisma: PrismaClient,
  boardId: string,
  organizationId: string | null,
): Promise<WidgetBoardScope> {
  return resolveBoardScope(prisma, boardId, { intelligenceOnly: false, organizationId });
}
