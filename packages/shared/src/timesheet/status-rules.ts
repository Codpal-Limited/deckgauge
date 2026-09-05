import type { StatusSpan } from './types.js';

export interface StatusRule {
  scope: 'ROLE' | 'EMPLOYEE';
  role: string | null;
  employeeId: string | null;
  inProgressStatuses: string[];
}

export interface ResolvedStatusConfig {
  statuses: Set<string>;
  useCategoryFallback: boolean;
}

/**
 * Status names that do NOT count as in-progress work: backlog ("To Do") states
 * and terminal ("Done") states. The zero-config fallback treats every *other*
 * status as in-progress — "anything that isn't To Do or Done".
 *
 * Why name-based and not category-based: the Jira changelog API does not carry
 * the status *category* per historical transition, so `jira_transitions.to_category`
 * is unreliable (it lands as 'Unknown'). The status *name* is reliable, so the
 * default rule keys off the name. Per-role / per-employee TimesheetStatusRules
 * still override this completely when configured.
 *
 * Keys are normalized via `normalizeStatusName` (lower-cased, punctuation/whitespace
 * collapsed to single spaces), so e.g. "Refining - Product" → "refining product".
 */
export const NON_IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set([
  // To Do / backlog
  'to do',
  'todo',
  'open',
  'backlog',
  'ready for development',
  'refining product',
  'ready for product',
  'ready for qa analysis',
  // Done / terminal
  'done',
  'closed',
  'resolved',
  'cancelled',
  'canceled',
  'ready for production',
  'ready for prod',
  'ready for deployment',
]);

/**
 * Status *names* (already normalized) that mean an issue has been delivered —
 * Jira's "Done" resolution states. Used by the ClickHouse intelligence builders
 * (flow-throughput-cycle, ch-completion-trend, delivery-trend-annotated) to
 * derive a Jira done-date from `jira_transitions.to_status`, because
 * `jira_transitions.to_category` is unreliable (always 'Unknown' — see above).
 *
 * Deliberately narrower than the "Done / terminal" block of
 * NON_IN_PROGRESS_STATUSES: it excludes cancelled/abandoned (terminal but NOT
 * delivered) and release-pipeline staging states like "Ready for Production"
 * (pre-done — counting them would overstate throughput), matching the
 * classic Jira Done-category resolution names.
 */
export const DONE_STATUS_NAMES: readonly string[] = ['done', 'closed', 'resolved'];

function normalizeStatusName(status: string): string {
  return status
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

/**
 * Default (no-rule) in-progress test: any status that is not a known To Do /
 * Done state. Unknown/new statuses default to in-progress, matching the rule
 * "register in-progress for all statuses that are not To Do".
 */
export function isInProgressByStatusName(status: string): boolean {
  return !NON_IN_PROGRESS_STATUSES.has(normalizeStatusName(status));
}

/** Resolve a person's in-progress status set: employee override → role → category fallback. */
export function resolveInProgressStatuses(
  employee: { id: string; role: string | null },
  rules: StatusRule[],
): ResolvedStatusConfig {
  const employeeRule = rules.find((r) => r.scope === 'EMPLOYEE' && r.employeeId === employee.id);
  if (employeeRule) {
    return { statuses: new Set(employeeRule.inProgressStatuses), useCategoryFallback: false };
  }
  const role = employee.role?.toLowerCase() ?? null;
  const roleRule =
    role === null
      ? undefined
      : rules.find((r) => r.scope === 'ROLE' && r.role?.toLowerCase() === role);
  if (roleRule) {
    return { statuses: new Set(roleRule.inProgressStatuses), useCategoryFallback: false };
  }
  return { statuses: new Set(), useCategoryFallback: true };
}

/** Whether a span counts as in-progress for the resolved config. */
export function spanIsInProgress(span: StatusSpan, config: ResolvedStatusConfig): boolean {
  if (config.statuses.has(span.status)) return true;
  if (config.useCategoryFallback) {
    // Prefer the real status category when present, but it is unreliable across
    // providers (Jira transitions land as 'Unknown'), so fall back to a
    // name-based rule: anything that is not a To Do / Done state counts.
    if (span.category === 'In Progress') return true;
    return isInProgressByStatusName(span.status);
  }
  return false;
}
