import type { RetiredJiraProject } from '@deckgauge/db';
import type { PageStateDeps, PageStateResult } from './page-state.types.js';
import {
  DAILY_CAP_SEMANTICS,
  readOrgTreeTimesheetConfigs,
  type OrgTreeConfigRead,
} from './org-tree-config-reads.js';
import { internalIdentifiersNote, MAX_CONFIG_ROWS, TRUNCATION_NOTE } from './page-state-notes.js';
import {
  buildGlobalRuleLayers,
  precedenceNote,
  readStatusRules,
  type StatusRuleRead,
} from './status-rule-layers.js';

/**
 * What actually decides whether a status bills hours on THIS instance.
 *
 * Reports all layers because the useful answer to "is my 'In Review' billing
 * hours?" is the reason, not just the verdict — and the layers do not reduce
 * to one instance-wide verdict:
 *
 * - `OrgTreeTimesheetConfig` is keyed per `orgTreeId`. A saved row overrides
 *   completely for THAT tree only, and the override is the existence of the
 *   row, not whether its list is non-empty — an empty `activeStatuses` is a
 *   valid, explicit "count nothing" for that tree (see
 *   `org-tree-timesheet-config.service.ts`'s `put` doc, and the bypass at
 *   `timesheet.service.ts:232-234`, which is `!= null`, not a length check).
 *   Read via `readOrgTreeTimesheetConfigs`, shared with the org resolver so the
 *   two report this table identically — including `dailyCapHours`, which
 *   answers "why is this tree capped at 8h?" on this page instead of leaving
 *   the model to answer it from the documented default.
 * - `TimesheetStatusRule` carries no `orgTreeId`: employee/role rules and the
 *   name-based default are genuinely global, and govern any tree WITHOUT an
 *   override row. Verified against `status-rules.ts:82-99` (employee beats
 *   role beats fallback) and `:102-112` (category checked first, then the
 *   name rule). Shaped by `buildGlobalRuleLayers`, shared with the org resolver.
 *
 * Organization-wide, matching the existing `GET /timesheet/status-rules` route it
 * borrows its authorization posture from: no board scope is involved, but the
 * caller's organization confines all three reads. Every one of them was
 * unfiltered until 2026-08-26 (TENANCY-PROGRAMME §5a) — `RetiredJiraProject` and
 * `TimesheetStatusRule` each carry their own `organizationId`, and the per-tree
 * overrides carry theirs through `OrgTree`.
 *
 * Every list is capped at `MAX_CONFIG_ROWS` with an explicit truncation flag,
 * matching the roadmap resolver's bound-plus-flag shape: an unbounded read is
 * both an unbounded query and an unbounded amount of LLM context.
 */
export async function resolveTimesheetPageState(deps: PageStateDeps): Promise<PageStateResult> {
  const [ruleRead, configRead, retired]: [StatusRuleRead, OrgTreeConfigRead, RetiredJiraProject[]] =
    await Promise.all([
      readStatusRules(deps.prisma, deps.organizationId),
      readOrgTreeTimesheetConfigs(deps.prisma, deps.organizationId),
      deps.prisma.retiredJiraProject.findMany({
        where: { organizationId: deps.organizationId },
        take: MAX_CONFIG_ROWS + 1,
      }),
    ]);

  const shownRetired = retired.slice(0, MAX_CONFIG_ROWS);

  return {
    available: true,
    page: 'timesheet',
    state: {
      orgTreeOverrides: configRead.overrides,
      orgTreeOverridesTruncated: configRead.truncated,
      precedence: precedenceNote('orgTreeOverrides'),
      dailyCapNote: DAILY_CAP_SEMANTICS,
      ...buildGlobalRuleLayers(ruleRead),
      retiredProjects: shownRetired.map((row) => ({
        projectKey: row.projectKey,
        cutoffDate: row.cutoffDate.toISOString().slice(0, 10),
      })),
      retiredProjectsTruncated: retired.length > MAX_CONFIG_ROWS,
      retiredNote:
        'Hours for a retired project are cut off at its cutoff date: a span crossing the cutoff is clipped short, and a span starting on or after the cutoff is dropped entirely. A retired project is the usual cause of hours appearing for work nobody is doing any more.',
      identifiersNote: `${internalIdentifiersNote('orgTreeId and employeeId')} Org trees do carry orgTreeName, joined from the org tree record, so a tree can be named; there is no equivalent name for employeeId, which cannot be resolved to a person here.`,
      truncationNote: TRUNCATION_NOTE,
    },
  };
}
