import type { PrismaClient } from '@deckgauge/db';
import {
  seedBucket,
  StatusBucketSchema,
  type PooledStatus,
  type StatusBucket,
} from '@deckgauge/shared';
import { fetchTransitions, type ChQueryClient } from '../timesheet/timesheet-fetch.js';
import { makeAssigneeResolver } from '../timesheet/assignee-resolver.js';

interface Deps {
  prisma: PrismaClient;
  clickhouse: ChQueryClient;
  now?: () => number;
}

/**
 * Jira's own category per status name.
 *
 * `FINAL` is required, not decorative: `jira_issues` is a
 * `ReplacingMergeTree(synced_at)`, so an unmerged stale row after a workflow
 * change can carry a different `status_category` for the same name. Without it
 * a plain `SELECT DISTINCT` returns both and the `Map` below collapses them
 * last-wins by whatever order ClickHouse happens to return — a status's bucket
 * would flip between reads with no input changing. `JIRA_PARENT_QUERY` in
 * `timesheet-fetch.ts` uses `FINAL` against this same table for a related
 * reason.
 *
 * No tenant filter, deliberately: `cockpit.jira_issues` is a tenant table and
 * the boundary is a ClickHouse ROW POLICY activated per request by the scoped
 * reader (`__isolation__/README.md` §4.2), which fails closed to an empty
 * result. A hand-written `organization_id` predicate here would be off-pattern.
 */
const CATEGORY_QUERY = `
  SELECT DISTINCT status, status_category
  FROM cockpit.jira_issues FINAL
  WHERE status != '' AND status_category != ''
`;

/**
 * The distinct statuses the timesheet could attribute to an org tree's people,
 * each carrying the bucket it currently means.
 *
 * The provider is deliberately NOT part of the result. The panel presents one
 * row per status NAME — business users do not know which tracker a status came
 * from and should not have to — so the shape returned here is the shape the
 * panel renders. Provider stays server-side, where it is needed for seeding and
 * (in the write path) for resolving which sources a decision applies to.
 */
export class OrgTreeStatusPoolService {
  private readonly prisma: PrismaClient;
  private readonly clickhouse: ChQueryClient;
  private readonly now: () => number;

  constructor(deps: Deps) {
    this.prisma = deps.prisma;
    this.clickhouse = deps.clickhouse;
    this.now = deps.now ?? Date.now;
  }

  /**
   * The pool for ONE tree. A thin wrapper over `listForTrees`, deliberately:
   * two implementations of the seeding priority would be exactly the drift this
   * whole feature exists to remove.
   *
   * A tree that does not exist answers `[]` rather than throwing. That is
   * defence in depth for the read route, which 404s first — but note the write
   * path THROWS for a missing tree instead, because there a silent `[]` reads
   * as "no decisions to write".
   */
  async listForTree(orgTreeId: string): Promise<PooledStatus[]> {
    return (await this.listForTrees([orgTreeId])).get(orgTreeId) ?? [];
  }

  /**
   * The pool for SEVERAL trees, from one pass over ClickHouse.
   *
   * This is the primitive rather than an optimisation of `listForTree`, and the
   * reason is the write path: bucket decisions are stored per SOURCE and read
   * per ORGANIZATION, while `OrgTreeTimesheetConfig.activeStatuses` — the list
   * the timesheet actually matches against — is cached per TREE. So saving a
   * decision has to refresh every tree in the organization, and doing that by
   * calling `listForTree` in a loop would pay one unbounded `FINAL` scan of
   * both transition tables PER TREE. Those scans are identical: transitions and
   * Jira categories are org-wide and carry no tree dimension. Only the employee
   * set differs.
   *
   * A tree with no employees gets an EMPTY entry, not a missing one — the write
   * path uses presence to decide whether it has a projection, and an omitted
   * tree would silently keep its stale cached list. A tree id that does not
   * exist is omitted, because there is no tree to project onto.
   */
  async listForTrees(orgTreeIds: string[]): Promise<Map<string, PooledStatus[]>> {
    const out = new Map<string, PooledStatus[]>();
    if (orgTreeIds.length === 0) return out;

    // The tenant comes from each TREE, not from the caller's membership.
    //
    // That is the correct owner of the data and not merely the convenient one:
    // these buckets belong to the organization whose statuses they describe, so
    // deriving the tenant from the resource cannot disagree with the resource.
    // Reading it off `req.membership` would have made the answer depend on
    // which organization the caller happened to be looking through — and the
    // policy layer has already established that this caller may read this tree.
    const trees = await this.prisma.orgTree.findMany({
      where: { id: { in: orgTreeIds } },
      select: { id: true, organizationId: true },
    });
    if (trees.length === 0) return out;
    for (const t of trees) out.set(t.id, []);

    const employees = await this.prisma.orgEmployee.findMany({
      where: { orgTreeId: { in: trees.map((t) => t.id) } },
      select: {
        id: true,
        name: true,
        orgTreeId: true,
        aliases: { select: { provider: true, kind: true, value: true } },
      },
    });
    const byTree = new Map<string, typeof employees>();
    for (const e of employees) {
      const list = byTree.get(e.orgTreeId);
      if (list) list.push(e);
      else byTree.set(e.orgTreeId, [e]);
    }
    // No employees anywhere in the batch means no assignee can resolve, so no
    // scan can change the answer — every tree keeps its empty entry. This
    // restores a short-circuit the single-tree version had and the batch lost:
    // `GET /timesheet-status-pool` on a freshly created tree was paying two
    // unbounded `FINAL` scans for a result that could only be empty. ONE tree
    // with employees is enough to need the data, so the guard is on the batch
    // rather than per tree.
    if (byTree.size === 0) return out;

    // `from = 0` deliberately: this is the pool of statuses an operator can pick
    // from, so it must be every status ever seen, not just those touched in some
    // window — a status would otherwise vanish from the config screen and silently
    // stop counting. 0 reproduces the old unbounded lower bound exactly (see
    // timesheet-fetch.ts). This one scan is therefore still unbounded by design;
    // it runs on a config screen, not the timesheet read path — and it is now ONE
    // scan for the whole batch rather than one per tree.
    const [transitions, categories, stored] = await Promise.all([
      fetchTransitions(this.clickhouse, 0, this.now()),
      this.jiraCategories(),
      // Scoped to the tenants, and that filter is the ONLY thing scoping it:
      // `SourceStatusBucket.sourceId` has no foreign key, so nothing in the
      // schema constrains a row to an organization. TENANCY-PROGRAMME §5a.
      // `organizationId` is SELECTED as well as filtered, so a batch spanning
      // two tenants cannot apply one tenant's decisions to the other's tree.
      this.prisma.sourceStatusBucket.findMany({
        where: { organizationId: { in: [...new Set(trees.map((t) => t.organizationId))] } },
        select: { organizationId: true, status: true, bucket: true },
      }),
    ]);

    // Keyed on the exact name the tracker reports. A case-insensitive match here
    // would either let `code review` override `Code Review`, or fail to match it
    // and silently re-seed over a decision a human made — and the store keeps
    // `status` verbatim precisely so this lookup can be exact.
    // `parse`, not a cast: `r.bucket` is Prisma's enum and `StatusBucket` is the
    // shared union. They are identical today and nothing else asserts they stay
    // so — this is where a schema edit on one side would otherwise pass silently.
    const decidedByOrg = new Map<string, Map<string, StatusBucket>>();
    for (const r of stored) {
      let m = decidedByOrg.get(r.organizationId);
      if (!m) decidedByOrg.set(r.organizationId, (m = new Map()));
      m.set(r.status, StatusBucketSchema.parse(r.bucket));
    }

    for (const tree of trees) {
      const treeEmployees = byTree.get(tree.id) ?? [];
      if (treeEmployees.length === 0) continue; // already seeded with []
      const resolve = makeAssigneeResolver(treeEmployees);

      // The provider is kept per status only until the bucket is decided — it is
      // what `seedBucket` needs to read the curated map, and it never leaves here.
      //
      // FIRST WRITER WINS for a name present under both trackers, and it is always
      // Jira: `fetchTransitions` ends `[...jira, ...ado]`, so the provider chosen
      // is deterministic even though row order within each arm is not.
      //
      // An earlier version of this comment claimed the two providers "would agree
      // on everything except a curated entry". That was false, and the way it was
      // false is the reason the category below is gated on provider: the category
      // map has no provider dimension, so an ADO state sharing a name with any
      // Jira issue in the organization was being bucketed from Jira's category.
      const providerFor = new Map<string, 'jira' | 'ado'>();
      for (const t of transitions) {
        if (!t.status) continue;
        if (resolve(t.assignee, t.provider) === null) continue;
        // Type narrowing, not a product decision: `Provider` has three members
        // and `seedBucket` takes `FocusProvider`, which has two. Unreachable
        // today — `fetchTransitions` unions Jira and ADO only — but if GitHub
        // transitions are ever added, these statuses vanish from the picker with
        // no error, so the line has to be found and revisited rather than trusted.
        if (t.provider === 'github') continue;
        if (!providerFor.has(t.status)) providerFor.set(t.status, t.provider);
      }

      const decided = decidedByOrg.get(tree.organizationId);
      out.set(
        tree.id,
        [...providerFor.entries()]
          .map(([status, provider]) => ({
            status,
            bucket:
              decided?.get(status) ??
              seedBucket({
                status,
                provider,
                // ONLY for Jira. The category map is keyed on status NAME with no
                // provider dimension, and `SeedBucketInput.statusCategory` is
                // documented `null` for ADO because ADO has none — so passing one
                // here would be Jira's opinion of a different tracker's state, and
                // rule 2 outranks the curated map and the name rule. ADO's Basic
                // process ships To Do / Doing / Done and Agile ships New / Active /
                // Resolved / Closed, every one a plausible Jira status name.
                statusCategory: provider === 'jira' ? (categories.get(status) ?? null) : null,
              }),
          }))
          // `localeCompare`, not a bare `.sort()`: a mixed-case pool otherwise
          // groups every capitalised status ahead of every lowercase one, which
          // reads as arbitrary on a config screen.
          .sort((a, b) => a.status.localeCompare(b.status)),
      );
    }
    return out;
  }

  /**
   * Jira's own `To Do` / `In Progress` / `Done` per status, from
   * `jira_issues.status_category`.
   *
   * NOT `jira_transitions.to_category`, which lands as `'Unknown'` for every row
   * by design — the changelog carries no category per historical transition.
   * That distinction cost a round of design review; the issues table is the only
   * place the category is real.
   */
  private async jiraCategories(): Promise<Map<string, string>> {
    const result = await this.clickhouse.query({ query: CATEGORY_QUERY, format: 'JSONEachRow' });
    const rows = (await result.json()) as Array<{ status: string; status_category: string }>;
    return new Map(rows.map((r) => [r.status, r.status_category]));
  }
}
