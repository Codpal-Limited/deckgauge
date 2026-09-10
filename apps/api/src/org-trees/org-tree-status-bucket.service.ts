import type { PrismaClient } from '@deckgauge/db';
import type { PooledStatus, StatusBucket } from '@deckgauge/shared';
import type { ChQueryClient } from '../timesheet/timesheet-fetch.js';
import type { OrgTreeStatusPoolService } from './org-tree-status-pool.service.js';

interface Deps {
  prisma: PrismaClient;
  clickhouse: ChQueryClient;
  /**
   * The read side, injected rather than constructed here. `save` derives
   * `activeStatuses` by asking the pool what the statuses mean AFTER writing,
   * so the two paths share one definition of "in progress" instead of each
   * carrying its own — see `deriveActive` below. The BATCH method, because the
   * derivation covers every tree in the organization.
   */
  pool: Pick<OrgTreeStatusPoolService, 'listForTrees'>;
}

/**
 * Which Jira projects have ever put an issue into one of these statuses.
 *
 * Read from `jira_transitions`, not `jira_issues`, and that is the whole point:
 * `jira_issues.status` is the CURRENT status, so a status no issue happens to
 * sit in right now would resolve to no project and the operator's decision
 * would be silently dropped. The pool itself is built from transitions, so
 * reading sources from the same table is what guarantees every status the panel
 * can show is a status this query can attribute.
 *
 * `project_key` is a real column here (it is in the ORDER BY), so there is no
 * need to split it out of `issue_key`.
 *
 * `FINAL` for the same reason as `CATEGORY_QUERY`: `ReplacingMergeTree`, and an
 * unmerged stale row could name a project that no longer reports the status. No
 * tenant predicate — `cockpit.*` is scoped by ROW POLICY, activated per request
 * by the scoped reader (`__isolation__/README.md` §4.2), which fails closed.
 *
 * Both queries were executed against a real ClickHouse (24.8, the test server on
 * :58123) with one tagged row, which is what settles the question a reader will
 * have here: `WHERE to_status` still resolves while `to_status` is aliased to
 * `status` in the SELECT, and the row comes back as `{status, project_key}`.
 * The `IN (...)` parentheses match the repo's existing parameterised `IN`
 * (`clickhouse-intelligence.service.ts`, `demo/remove.ts`); both forms parse.
 */
const JIRA_SOURCE_QUERY = `
  SELECT DISTINCT to_status AS status, project_key
  FROM cockpit.jira_transitions FINAL
  WHERE to_status IN ({statuses:Array(String)})
`;

/** The ADO half of the same question. `to_state` is ADO's word for `to_status`. */
const ADO_SOURCE_QUERY = `
  SELECT DISTINCT to_state AS status, project
  FROM cockpit.ado_transitions FINAL
  WHERE to_state IN ({statuses:Array(String)})
`;

/** Prisma's enum spelling of the shared lowercase provider union. */
const PROVIDER_JIRA = 'JIRA' as const;
const PROVIDER_ADO = 'ADO' as const;

/** key → every id under it. See `resolveSources` for why one key can have many. */
function groupIds(pairs: Array<readonly [string, string]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, id] of pairs) {
    const list = out.get(key);
    if (list) list.push(id);
    else out.set(key, [id]);
  }
  return out;
}

interface ResolvedSource {
  provider: typeof PROVIDER_JIRA | typeof PROVIDER_ADO;
  sourceId: string;
}

/**
 * Saving what a status MEANS, for every source that reports it.
 *
 * The operator makes one decision per status NAME — business users do not know
 * which tracker a status came from and must not have to (that requirement is
 * why the picker has no provider column). This service is where that single
 * decision fans out to the sources it actually applies to, which is the only
 * place in the stack that has to know about trackers at all.
 */
export class OrgTreeStatusBucketService {
  private readonly prisma: PrismaClient;
  private readonly clickhouse: ChQueryClient;
  private readonly pool: Pick<OrgTreeStatusPoolService, 'listForTrees'>;

  constructor(deps: Deps) {
    this.prisma = deps.prisma;
    this.clickhouse = deps.clickhouse;
    this.pool = deps.pool;
  }

  /**
   * Store the decisions and return the `activeStatuses` they imply.
   *
   * Returns the derived list rather than nothing, so the caller can hand the
   * client the same value the timesheet will read on its next request instead of
   * recomputing it a second way.
   */
  async save(orgTreeId: string, decisions: PooledStatus[]): Promise<string[]> {
    // The tenant comes from the TREE, not from the caller's membership — the
    // owner of the data rather than the caller's view of it. Reading
    // `req.membership` here would make the row's organization depend on which
    // organization the operator happened to be looking through, and the policy
    // layer has already established that this caller may edit this tree.
    const tree = await this.prisma.orgTree.findUnique({
      where: { id: orgTreeId },
      select: { organizationId: true },
    });
    // Thrown rather than returned as an empty result: `listForTree` answers `[]`
    // for a missing tree because an empty picker is a truthful read, but a WRITE
    // that quietly succeeds having stored nothing is the silent-empty failure
    // this repo has now paid for twice.
    if (!tree) throw new Error(`org tree ${orgTreeId} not found`);

    // Deduplicated, and the last decision for a name wins. The panel renders one
    // row per name, so a duplicate is a client bug rather than a conflict worth
    // an error — but it must not double the `IN` list or the upsert count.
    const byStatus = new Map<string, StatusBucket>(
      decisions.map((d) => [d.status, d.bucket] as const),
    );

    if (byStatus.size > 0) {
      const sources = await this.resolveSources(tree.organizationId, [...byStatus.keys()]);
      const rows = [...byStatus.entries()].flatMap(([status, bucket]) =>
        (sources.get(status) ?? []).map((s) => ({
          organizationId: tree.organizationId,
          provider: s.provider,
          sourceId: s.sourceId,
          status,
          bucket,
        })),
      );
      // One transaction for all of them, and BATCHED rather than a loop inside
      // an interactive callback.
      //
      // A half-applied save would leave some sources decided and the rest
      // seeded, and `activeStatuses` — recomputed below and only on success —
      // would then describe a state no one chose. That is the transaction.
      //
      // The array form is what makes it survive a real payload: Prisma's
      // interactive form carries a 5s default timeout (nothing in
      // `createPrismaClient` overrides it) and one round trip per statement, so
      // tens of statuses across tens of synced projects would be hundreds of
      // serial round trips against that ceiling — and a P2028 there fails the
      // entire save. The array form has no such timeout and goes as one batch.
      if (rows.length > 0) {
        await this.prisma.$transaction(
          rows.map((row) =>
            this.prisma.sourceStatusBucket.upsert({
              where: {
                organizationId_provider_sourceId_status: {
                  organizationId: row.organizationId,
                  provider: row.provider,
                  sourceId: row.sourceId,
                  status: row.status,
                },
              },
              create: row,
              update: { bucket: row.bucket },
            }),
          ),
        );
      }
    }

    return this.deriveActive(tree.organizationId, orgTreeId);
  }

  /**
   * Recompute `activeStatuses` for EVERY tree in the organization, and return
   * the saved tree's.
   *
   * DERIVED, never assembled from the submitted decisions. `activeStatuses` is
   * the list `spanIsInProgress` matches against, so if it were built from this
   * request's payload it would omit every status the operator did not touch —
   * including all the seeded ones — and the timesheet would count a different
   * set from the one the panel displays. Reading the pool is the only way the
   * two can be the same list by construction rather than by agreement.
   *
   * REFRESHED org-wide, but CREATED only for the saved tree, and the asymmetry
   * is the whole point.
   *
   * The config row is not a cache line — it is an OVERRIDE. When it exists,
   * `computeTimesheet` uses `activeStatuses` INSTEAD of the per-role and
   * per-employee `TimesheetStatusRule`s that `resolveInProgressStatuses`
   * returns, and it sets `useCategoryFallback: false` so a status absent from
   * the list stops counting (`packages/shared/src/timesheet/aggregate.ts`).
   * `advisor/page-state/org-tree-config-reads.ts` calls the table `overrides`
   * for exactly that reason. An earlier version of this method created a row
   * for every tree in the organization, which silently retired
   * `/timesheet/status-rules` on trees nobody had opened — no undo in the UI, no
   * message, their numbers just changed. Code review blocked on it.
   *
   * So: the mapping belongs to the SOURCE, and whoever reads that source decides
   * how to read its statuses. Configuration is therefore OPT-IN PER TREE — the
   * owner of a tree turns it on by saving there. `upsert` for the saved tree
   * because its owner acted; `updateMany` for the rest, whose `where` is the
   * primary key so it touches one row or none. A tree already on buckets stays
   * in step (its sources' meaning genuinely changed); a tree nobody configured
   * is left alone.
   *
   * The refresh still has to reach the other trees, because a decision is stored
   * per source and read per ORGANIZATION — `listForTrees` filters on
   * `organizationId` with no tree predicate — while this projection is per TREE.
   * Refreshing only the saved tree would leave a tree that IS on buckets showing
   * one thing in the panel and counting another.
   *
   * It runs AFTER the write and outside the transaction. Outside because the
   * pool queries ClickHouse, and holding a Postgres transaction open across a
   * network read to another server would be a lock held for no benefit.
   *
   * RESIDUAL, deliberate: if a config upsert fails after the rows are written,
   * the stored decisions are ahead of the cached lists until the next save. The
   * rows are the source of truth and `activeStatuses` is a projection of them,
   * so the recovery is idempotent — re-saving reconciles — and the alternative
   * is the cross-server transaction above.
   */
  private async deriveActive(organizationId: string, savedTreeId: string): Promise<string[]> {
    const trees = await this.prisma.orgTree.findMany({
      where: { organizationId },
      select: { id: true },
    });
    // ONE pool call for all of them. `listForTrees` exists for this: a loop
    // would pay an unbounded `FINAL` scan of both transition tables per tree,
    // and those scans are identical across trees.
    const pooled = await this.pool.listForTrees(trees.map((t) => t.id));

    let saved: string[] = [];
    for (const tree of trees) {
      // ONLY `IN_PROGRESS`. `WAITING_TO_SHIP` is finished-but-parked and must not
      // count as worked time — separating those two is the reason there are five
      // buckets rather than four, and it is where the 16-status correction lands:
      // `Ready to Deploy`, `Deployed to Uat` and the rest stop accruing hours here.
      const activeStatuses = (pooled.get(tree.id) ?? [])
        .filter((p) => p.bucket === 'IN_PROGRESS')
        .map((p) => p.status);
      // `dailyCapHours` is deliberately absent from every branch below. It is
      // set by the other endpoint; naming it here — even as `null` on a create —
      // would reset a configured cap to the 8h engine default on every save.
      if (tree.id === savedTreeId) {
        await this.prisma.orgTreeTimesheetConfig.upsert({
          where: { orgTreeId: tree.id },
          create: { orgTreeId: tree.id, activeStatuses },
          update: { activeStatuses },
        });
        saved = activeStatuses;
      } else {
        // No `create`. `orgTreeId` is the primary key, so this touches one row
        // or none — which is what makes configuration opt-in rather than
        // something a neighbouring tree's Save imposes.
        await this.prisma.orgTreeTimesheetConfig.updateMany({
          where: { orgTreeId: tree.id },
          data: { activeStatuses },
        });
      }
    }
    return saved;
  }

  /**
   * status name → the sources that report it, as `SourceStatusBucket` needs them.
   *
   * Two hops, and the second is what scopes the result: ClickHouse names a
   * PROJECT (a key or an ADO project name), which is not globally unique, and
   * the transition tables are scoped by row policy rather than by a predicate
   * this code can see. So the project is resolved to a sync row through its
   * INSTANCE, whose `organizationId` is non-nullable — an unscoped lookup would
   * otherwise file this organization's decision against another tenant's sync
   * row. Slice 2b-ii shipped the same class of bug in the other direction (one
   * tracker's category applied to another's status) and this is the guard.
   */
  private async resolveSources(
    organizationId: string,
    statuses: string[],
  ): Promise<Map<string, ResolvedSource[]>> {
    const [jiraRows, adoRows] = await Promise.all([
      this.chRows<{ status: string; project_key: string }>(JIRA_SOURCE_QUERY, statuses),
      this.chRows<{ status: string; project: string }>(ADO_SOURCE_QUERY, statuses),
    ]);

    const [jiraSyncs, adoSyncs] = await Promise.all([
      jiraRows.length === 0
        ? []
        : this.prisma.jiraProjectSync.findMany({
            where: {
              jiraInstance: { organizationId },
              jiraProjectKey: { in: [...new Set(jiraRows.map((r) => r.project_key))] },
            },
            select: { id: true, jiraProjectKey: true },
          }),
      adoRows.length === 0
        ? []
        : this.prisma.azureDevOpsProjectSync.findMany({
            where: {
              azureDevOpsInstance: { organizationId },
              adoProject: { in: [...new Set(adoRows.map((r) => r.project))] },
            },
            select: { id: true, adoProject: true },
          }),
    ]);

    // MULTIMAPS, and this is a correctness requirement rather than generality.
    //
    // `JiraProjectSync` is unique per `[jiraInstanceId, jiraProjectKey]` and
    // `AzureDevOpsProjectSync` per `[azureDevOpsInstanceId, adoProject]` — per
    // INSTANCE, not per organization — and one organization may hold several
    // instances (a demo instance beside a real one is the shipped case). Two
    // instances syncing `PROJ`, or two ADO organizations each with a `Default`
    // project, give two sync rows under one key. `jira_transitions` carries no
    // instance column, so both legitimately match, and a plain `Map` would keep
    // the last and leave the other source with no decision at all — invisible
    // today, because the read still matches on the status NAME across the whole
    // organization, and a real defect the moment anything reads per source.
    //
    // A project ClickHouse reports but Postgres has no sync row for resolves to
    // nothing and is skipped, not guessed: that is a source removed after its
    // history was synced, and there is nothing to attribute the decision to.
    const jiraByKey = groupIds(jiraSyncs.map((s) => [s.jiraProjectKey, s.id] as const));
    const adoByProject = groupIds(adoSyncs.map((s) => [s.adoProject, s.id] as const));

    const out = new Map<string, ResolvedSource[]>();
    const add = (status: string, source: ResolvedSource) => {
      const list = out.get(status);
      if (list) list.push(source);
      else out.set(status, [source]);
    };
    for (const r of jiraRows) {
      for (const sourceId of jiraByKey.get(r.project_key) ?? []) {
        add(r.status, { provider: PROVIDER_JIRA, sourceId });
      }
    }
    for (const r of adoRows) {
      for (const sourceId of adoByProject.get(r.project) ?? []) {
        add(r.status, { provider: PROVIDER_ADO, sourceId });
      }
    }
    return out;
  }

  private async chRows<T>(query: string, statuses: string[]): Promise<T[]> {
    const result = await this.clickhouse.query({
      query,
      query_params: { statuses },
      format: 'JSONEachRow',
    });
    return (await result.json()) as T[];
  }
}
