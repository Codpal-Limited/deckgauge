import type { ChReadClient } from '../analytics/ch-read-scope.js';

export interface AdoAreaPathRow {
  areaPath: string;
  workItemCount: number;
}

/**
 * The area paths that actually carry work items for one (org, project) pair,
 * for the board source's intelligence-scope picker (Task 9).
 *
 * Read from ClickHouse rather than the ADO classification-nodes API: the data is
 * already ingested, so this needs no new ADO call and no token. Tradeoff — an
 * area path with no work items yet does not appear. Acceptable: selecting an
 * empty area path would narrow the board to nothing anyway.
 *
 * `FINAL` and the (org_url, project) filter match exactly what
 * `adoScopeFilter`'s `areaPathColumn` option applies at query time
 * (`apps/api/src/widgets/unions.ts`) — this list must show the same area paths
 * the eventual filter can actually narrow to.
 *
 * Takes a `ChReadClient` (the per-request, organization-role-scoped reader),
 * never a raw `ClickHouseClient` — see `apps/api/src/analytics/ch-read-scope.ts`.
 * The raw ingest singleton carries a permissive row policy that reads every
 * tenant, so passing it here would leak area-path names across organizations.
 */
export async function listAdoAreaPaths(
  ch: ChReadClient,
  scope: { orgUrl: string; project: string },
): Promise<AdoAreaPathRow[]> {
  const result = await ch.query({
    query: `
      SELECT area_path, count() AS work_item_count
      FROM cockpit.ado_work_items FINAL
      WHERE org_url = {orgUrl:String} AND project = {project:String}
      GROUP BY area_path
      ORDER BY work_item_count DESC
    `,
    query_params: { orgUrl: scope.orgUrl, project: scope.project },
    format: 'JSONEachRow',
  });
  const rows = (await result.json()) as Array<{
    area_path: string;
    work_item_count: string | number;
  }>;
  return rows.map((r) => ({ areaPath: r.area_path, workItemCount: Number(r.work_item_count) }));
}
