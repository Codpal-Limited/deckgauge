import type { PrismaClient } from '@deckgauge/db';
import { hasActiveJqlFilter, JQL_FILTER_MATCHES_NOTHING_KEY } from '@deckgauge/shared';
import type { ChReadClient } from '../../analytics/ch-read-scope.js';

export interface ResolvedScope {
  github: string[];
  jira: string[];
  ado: string[];
  gitlab: string[];
  /**
   * Per-project issue-key allow-lists, from `board_jira_source_keys`. A project
   * absent from this map, or present with an empty array, is UNNARROWED —
   * "empty means all", never "none".
   *
   * Optional so the many hand-built scopes in tests keep compiling; a scope with
   * neither map behaves exactly as it did before this field existed.
   */
  jiraIssueKeysByProject?: Record<string, string[]>;
  /**
   * Per-project ADO area paths, EXPANDED to the exact set beneath each chosen
   * prefix.
   *
   * The builders compare by prefix (`startsWith`), which is not an `IN`, and
   * `assert.ts` recognises only `IN`. The console bakes values into the SQL
   * anyway, so resolution expands each prefix here and the rewriter injects
   * `area_path IN (…)` — one uniform assertion across providers.
   *
   * Tradeoff: an area path created between resolutions is absent until the next
   * one. That fails CLOSED — a missing path narrows, never widens.
   */
  adoAreaPathsByProject?: Record<string, string[]>;
}

/**
 * The SQL console's board scope: the external identifiers a user's authored SQL
 * is rewritten to filter on.
 *
 * `organizationId` is REQUIRED — nullable, but required — so a call site that has
 * not thought about the tenant boundary fails to compile. `null` is the
 * membership-less break-glass identity and is deliberately UNSCOPED, matching
 * `intelligence/board-scope.ts` and `policy.ts`'s no-membership fallback.
 *
 * `getCh` is REQUIRED for the same reason, and it is a PARAMETER rather than the
 * `getConsoleClickhouse()` singleton, matching how `executeUserSql` takes its
 * client: the ADO half of the board filter cannot be resolved from Postgres
 * alone (see {@link ResolvedScope.adoAreaPathsByProject}), and a scope resolved
 * without it would silently drop a dimension the console is supposed to enforce.
 *
 * It is a GETTER rather than a client because the second caller,
 * `buildSchemaPayload`, reads only the four identifier lists — it needs the
 * scope to know which TABLES a board may read, never the narrowing maps — and
 * 24 of the 25 ADO sources in this install configure no area paths at all. An
 * eager client would make that hot route construct one per request for a feature
 * it does not use; a lazy one is called only when a narrowed project actually
 * has a prefix to expand. Required-but-lazy keeps the property that matters: a
 * caller cannot resolve a scope with a scoping dimension missing.
 *
 * This is a THIRD board-scope resolver, alongside `getBoardScope` and
 * `getWidgetBoardScope` (which share `resolveBoardScope`). Those two gained this
 * predicate first and this one was missed, because that sweep followed a file
 * list rather than the shape. Kept separate rather than merged here because it
 * returns a different type (`ResolvedScope`, four plain string lists, consumed by
 * the SQL rewriter) — merging is a refactor, and a refactor is not what closes a
 * tenancy gap.
 *
 * The predicate goes through the `board` relation: these four source tables carry
 * no `organizationId` of their own, reaching a tenant through `Board`.
 */
export async function resolveScope(
  prisma: PrismaClient,
  boardId: string,
  organizationId: string | null,
  getCh: () => ChReadClient,
): Promise<ResolvedScope> {
  const tenantFilter = organizationId ? { board: { organizationId } } : {};
  const [github, jira, ado, gitlab] = await Promise.all([
    prisma.boardGitHubSource.findMany({
      where: { boardId, ...tenantFilter },
      select: { gitHubRepoSync: { select: { repoFullName: true } } },
    }),
    prisma.boardJiraSource.findMany({
      where: { boardId, ...tenantFilter },
      select: {
        jqlFilter: true,
        jiraProjectSync: { select: { jiraProjectKey: true } },
        filteredKeys: { select: { issueKey: true } },
      },
    }),
    prisma.boardAdoSource.findMany({
      where: { boardId, ...tenantFilter },
      select: {
        intelligenceAreaPaths: true,
        azureDevOpsProjectSync: {
          select: {
            adoProject: true,
            azureDevOpsInstance: { select: { orgUrl: true } },
          },
        },
      },
    }),
    prisma.boardGitLabSource.findMany({
      where: { boardId, ...tenantFilter },
      select: { gitlabProjectSync: { select: { projectPath: true } } },
    }),
  ]);

  return {
    github: github.map((r) => r.gitHubRepoSync.repoFullName),
    jira: jira.map((r) => r.jiraProjectSync.jiraProjectKey),
    ado: ado.map((r) => r.azureDevOpsProjectSync.adoProject),
    gitlab: gitlab.map((r) => r.gitlabProjectSync.projectPath),
    jiraIssueKeysByProject: collectJiraIssueKeys(jira),
    adoAreaPathsByProject: await expandAdoAreaPaths(getCh, ado),
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * The per-project issue-key allow-list, unioned across the board's sources.
 *
 * An UNFILTERED source on a project wins and leaves the project at `[]` — "empty
 * means all", the same rule `resolveBoardScope`'s `jiraProjectRefs` follows, and
 * for the same reason: a board that has not been narrowed must keep seeing
 * everything.
 *
 * A source whose `jqlFilter` is ACTIVE but currently matches zero issues must
 * NOT be read the same way: `filteredKeys` (`board_jira_source_keys`) is empty
 * in both cases, so `hasActiveJqlFilter(source.jqlFilter)` is what tells them
 * apart, and the zero-match case contributes the sentinel
 * `JQL_FILTER_MATCHES_NOTHING_KEY` instead of `[]` — a value no real Jira key
 * can match, so the console's guarded-disjunction rewrite narrows the project
 * to nothing rather than falling open to "no restriction". Same defect, same
 * fix, as `resolveBoardScope` in `intelligence/board-scope.ts`; see that file's
 * `resolveSourceIssueKeys` for the fuller writeup and the ADO analogue.
 */
function collectJiraIssueKeys(
  sources: ReadonlyArray<{
    jqlFilter?: string | null;
    jiraProjectSync: { jiraProjectKey: string } | null;
    filteredKeys?: ReadonlyArray<{ issueKey: string }>;
  }>,
): Record<string, string[]> {
  const byProject: Record<string, string[]> = {};
  for (const source of sources) {
    const projectKey = source.jiraProjectSync?.jiraProjectKey;
    if (!projectKey) continue;
    const realKeys = (source.filteredKeys ?? []).map((k) => k.issueKey);
    const keys =
      realKeys.length > 0
        ? realKeys
        : hasActiveJqlFilter(source.jqlFilter)
          ? [JQL_FILTER_MATCHES_NOTHING_KEY]
          : [];
    // An unfiltered source on the project clears any narrowing for it.
    if (keys.length === 0) {
      byProject[projectKey] = [];
      continue;
    }
    if (byProject[projectKey]?.length === 0) continue;
    byProject[projectKey] = [...new Set([...(byProject[projectKey] ?? []), ...keys])];
  }
  return byProject;
}

/**
 * The per-project ADO area paths, each chosen PREFIX expanded into the concrete
 * paths beneath it.
 *
 * One query per narrowed project, not per prefix: ClickHouse evaluates the
 * `arrayExists` in a single pass and the projects narrowed on any one board are
 * few (one, on every board in this install today). A board with no narrowed
 * project issues no query — and never calls `getCh`, so on that path no client
 * is constructed at all.
 *
 * The prefixes are UNIONED into the result rather than replaced by it, and that
 * is what makes the empty case fail closed. `[]` means "no restriction"
 * downstream, so a narrowed project whose subtree happens to hold no rows yet
 * must not resolve to `[]`; a prefix is trivially a member of its own subtree
 * (`startsWith(p, p)`), so keeping it narrows without widening.
 */
async function expandAdoAreaPaths(
  getCh: () => ChReadClient,
  sources: ReadonlyArray<{
    intelligenceAreaPaths?: string[];
    azureDevOpsProjectSync: {
      adoProject: string;
      azureDevOpsInstance: { orgUrl: string } | null;
    } | null;
  }>,
): Promise<Record<string, string[]>> {
  // Keyed by project NAME because that is all `ResolvedScope.ado` carries, and
  // the rewriter can only inject a predicate on a column the scope names.
  const wanted = new Map<string, { orgUrls: Set<string>; prefixes: Set<string> | null }>();
  for (const source of sources) {
    const project = source.azureDevOpsProjectSync?.adoProject;
    if (!project) continue;
    const orgUrl = source.azureDevOpsProjectSync?.azureDevOpsInstance?.orgUrl;
    const prefixes = source.intelligenceAreaPaths ?? [];
    const existing = wanted.get(project);
    if (!existing) {
      wanted.set(project, {
        orgUrls: new Set(orgUrl ? [orgUrl.replace(/\/+$/, '')] : []),
        prefixes: prefixes.length > 0 ? new Set(prefixes) : null,
      });
      continue;
    }
    if (orgUrl) existing.orgUrls.add(orgUrl.replace(/\/+$/, ''));
    // Either side unnarrowed ⇒ the project stays unnarrowed.
    if (prefixes.length === 0) {
      existing.prefixes = null;
      continue;
    }
    if (existing.prefixes !== null) for (const p of prefixes) existing.prefixes.add(p);
  }

  // Settle every project that needs no query FIRST, so `getCh` is reached only
  // when there is genuinely something to expand.
  const byProject: Record<string, string[]> = {};
  const toExpand: Array<[string, { orgUrls: Set<string>; prefixes: Set<string> }]> = [];
  for (const [project, entry] of wanted) {
    const { orgUrls, prefixes } = entry;
    if (prefixes === null || prefixes.size === 0) {
      byProject[project] = [];
      continue;
    }
    if (orgUrls.size === 0) {
      // The instance relation is required in the schema, so this should not
      // happen — and if it does, the answer is the narrow one: keep the
      // prefixes rather than resolve the project to "no restriction".
      byProject[project] = [...prefixes];
      continue;
    }
    toExpand.push([project, { orgUrls, prefixes }]);
  }
  if (toExpand.length === 0) return byProject;

  const ch = getCh();
  await Promise.all(
    toExpand.map(async ([project, { orgUrls, prefixes }]) => {
      const prefixList = [...prefixes];
      const result = await ch.query({
        query: `
        SELECT DISTINCT area_path
        FROM cockpit.ado_work_items
        WHERE org_url IN {orgUrls:Array(String)} AND project = {project:String}
          AND arrayExists(p -> startsWith(area_path, p), {prefixes:Array(String)})
      `,
        query_params: { orgUrls: [...orgUrls], project, prefixes: prefixList },
        format: 'JSONEachRow',
      });
      const rows = (await result.json()) as Array<{ area_path: string }>;
      byProject[project] = [...new Set([...prefixList, ...rows.map((r) => r.area_path)])];
    }),
  );
  return byProject;
}
