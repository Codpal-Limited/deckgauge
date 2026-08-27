import type { PageStateDeps, PageStateResult } from './page-state.types.js';
import {
  DAILY_CAP_SEMANTICS,
  ORG_TREE_OVERRIDE_SEMANTICS,
  readOrgTreeTimesheetConfigs,
  type OrgTreeConfigRead,
} from './org-tree-config-reads.js';
import { internalIdentifiersNote, TRUNCATION_NOTE } from './page-state-notes.js';
import {
  buildGlobalRuleLayers,
  precedenceNote,
  readStatusRules,
  type StatusRuleRead,
} from './status-rule-layers.js';

/**
 * Per-org-tree timesheet overrides — the `OrgTreeTimesheetConfig` row that
 * REPLACES the global timesheet default for that one org tree — PLUS the global
 * layer those overrides sit on top of.
 *
 * Both reads are confined to the caller's organization — see the notes on
 * `readOrgTreeTimesheetConfigs` and `readStatusRules`, which is where the
 * predicates live and where §5a's sweep found them missing.
 *
 * The global layer is included rather than referred to. The page key is closure
 * state fixed by the route, so from the org page the timesheet resolver is
 * unreachable: an earlier note telling the model to "see the timesheet page
 * state for those rules" pointed at data it had no way to fetch, which is worse
 * than saying nothing. Including it costs one extra capped read of a table that
 * is genuinely instance-wide (`TimesheetStatusRule` has no `orgTreeId`), and it
 * is precisely the layer that governs any tree absent from the override list —
 * i.e. the answer to the most likely question asked from this page.
 *
 * Both reads are shared with `resolveTimesheetPageState`
 * (`readOrgTreeTimesheetConfigs`, `buildGlobalRuleLayers`) so the two pages
 * cannot describe the same tables differently. Each list is capped with an
 * explicit truncation flag.
 */
export async function resolveOrgPageState(deps: PageStateDeps): Promise<PageStateResult> {
  const [configRead, ruleRead]: [OrgTreeConfigRead, StatusRuleRead] = await Promise.all([
    readOrgTreeTimesheetConfigs(deps.prisma, deps.organizationId),
    readStatusRules(deps.prisma, deps.organizationId),
  ]);

  return {
    available: true,
    page: 'org',
    state: {
      timesheetConfigOverrides: configRead.overrides,
      timesheetConfigOverridesTruncated: configRead.truncated,
      ...buildGlobalRuleLayers(ruleRead),
      note: `${ORG_TREE_OVERRIDE_SEMANTICS} An org tree absent from this list is governed by the global layer instead, which is included here: ${precedenceNote('timesheetConfigOverrides')} ${DAILY_CAP_SEMANTICS}`,
      identifiersNote: `${internalIdentifiersNote('orgTreeId and employeeId')} Org trees do carry orgTreeName, joined from the org tree record, so a tree can be named; there is no equivalent name for employeeId, which cannot be resolved to a person here.`,
      truncationNote: TRUNCATION_NOTE,
    },
  };
}
