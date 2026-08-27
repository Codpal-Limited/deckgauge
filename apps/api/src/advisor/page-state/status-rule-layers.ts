import type { PrismaClient, TimesheetStatusRule } from '@deckgauge/db';
import { NON_IN_PROGRESS_STATUSES } from '@deckgauge/shared';
import { MAX_CONFIG_ROWS } from './page-state-notes.js';

/**
 * The global timesheet rule layer — `TimesheetStatusRule` rows plus the
 * name-based default they fall back to.
 *
 * Shared by the timesheet and org resolvers so the two describe the same table
 * the same way. `TimesheetStatusRule` carries no `orgTreeId`: these rows govern
 * any org tree WITHOUT an `OrgTreeTimesheetConfig` row, which is exactly why the
 * org page needs them too — from the org page the timesheet resolver is
 * unreachable (the page key is closure state fixed by the route), so a note
 * pointing at "the timesheet page state" would point at data the model cannot
 * fetch.
 *
 * "No `orgTreeId`" is NOT "no tenant". An earlier version of this comment called
 * these rows "genuinely instance-wide", and the read matched: a bare `take`, no
 * `where`. `TimesheetStatusRule` has carried its own `organizationId` column
 * since the org-tenancy migration, so that read handed every organization's
 * employee and role rules to any authenticated caller's Advisor. Global ACROSS
 * ORG TREES, scoped to ONE ORGANIZATION — swept and fixed 2026-08-26,
 * TENANCY-PROGRAMME §5a.
 */
export interface StatusRuleRead {
  rules: readonly TimesheetStatusRule[];
  truncated: boolean;
}

/**
 * Reads one more row than it reports, so "more rows exist" is known without a
 * second `count` query.
 */
export async function readStatusRules(
  prisma: PrismaClient,
  organizationId: string,
): Promise<StatusRuleRead> {
  const rows = await prisma.timesheetStatusRule.findMany({
    where: { organizationId },
    take: MAX_CONFIG_ROWS + 1,
  });
  return { rules: rows.slice(0, MAX_CONFIG_ROWS), truncated: rows.length > MAX_CONFIG_ROWS };
}

export interface GlobalRuleLayers {
  /**
   * Whether any employee/role rule row EXISTS — not whether one covers any
   * particular person. Named for what it measures: a previous name
   * ("in force") invited the model to report that employee or role rules
   * govern someone no rule actually names.
   */
  globalRulesConfigured: 'employee or role rules exist' | 'no employee or role rules exist';
  employeeRules: readonly { employeeId: string | null; inProgressStatuses: readonly string[] }[];
  roleRules: readonly { role: string | null; inProgressStatuses: readonly string[] }[];
  statusRulesTruncated: boolean;
  defaultExcludedStatuses: readonly string[];
  defaultNote: string;
  ruleMatchingNote: string;
}

/**
 * How a rule's status list is actually matched, which the normalization prose
 * on the default path does NOT describe: `spanIsInProgress`
 * (`packages/shared/src/timesheet/status-rules.ts`) tests
 * `config.statuses.has(span.status)` on the RAW status name, so an employee or
 * role rule matches exactly and case-sensitively. Without this, a model can
 * affirm a rule match the engine would never make.
 */
const RULE_MATCHING_NOTE =
  'An employee or role rule matches a status by EXACT, case-sensitive name: the engine tests the raw status name against the listed set, with no lower-casing and no whitespace/underscore/hyphen collapsing. A rule listing "in review" therefore does NOT match a status displayed as "In Review". The normalization described in defaultNote applies only to the name-based default path. Which rule is selected is a separate matter: an employee rule is selected by exact internal employee id, and a role rule by role name compared case-insensitively.';

const DEFAULT_NOTE =
  'Under the default, a status whose category is reported as "In Progress" counts immediately. Only when the category does not resolve that way does the name rule apply: the status counts unless its normalized name is in the excluded list. Names are normalized by lower-casing and collapsing whitespace, underscores and hyphens only — other punctuation is left alone, so "Ready/QA" and "Ready QA" are different statuses.';

export function buildGlobalRuleLayers(read: StatusRuleRead): GlobalRuleLayers {
  return {
    globalRulesConfigured:
      read.rules.length > 0 ? 'employee or role rules exist' : 'no employee or role rules exist',
    employeeRules: read.rules
      .filter((rule) => rule.scope === 'EMPLOYEE')
      .map((rule) => ({ employeeId: rule.employeeId, inProgressStatuses: rule.inProgressStatuses })),
    roleRules: read.rules
      .filter((rule) => rule.scope === 'ROLE')
      .map((rule) => ({ role: rule.role, inProgressStatuses: rule.inProgressStatuses })),
    statusRulesTruncated: read.truncated,
    defaultExcludedStatuses: [...NON_IN_PROGRESS_STATUSES],
    defaultNote: DEFAULT_NOTE,
    ruleMatchingNote: RULE_MATCHING_NOTE,
  };
}

/**
 * The precedence prose, shared so the two resolvers cannot describe the same
 * layering differently. `overridesField` names the field in THAT payload which
 * lists the per-tree overrides, since the two resolvers report it under
 * different keys.
 */
export function precedenceNote(overridesField: string): string {
  return (
    `A saved org-tree active-status list overrides completely, but ONLY for the trees listed in ${overridesField} — ` +
    'including an empty list, which explicitly means "count nothing" for that tree (countsNothing: true). ' +
    'Every other tree uses the global layer: an employee-level rule beats a role-level rule; if no rule names that ' +
    'employee and no rule names their role, the name-based default applies to them.'
  );
}
