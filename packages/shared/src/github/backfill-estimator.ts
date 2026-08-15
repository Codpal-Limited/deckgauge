// GitHub backfill estimation. Moved here from the worker so the API can share it.
export interface RepoCostInput {
  openIssuesCount: number;
  lastPushedAt: Date | null;
}

export function estimateBackfillCost(
  repos: RepoCostInput[],
  opts: { backfillMonths: number },
): { requests: number; minutes: number } {
  const MIN_PER_REPO = 12;
  const PER_HUNDRED_ISSUES = 10;
  const PER_MONTH_MULT = 1.05;
  const SANITY_CAP = 999_999;

  const requests = Math.min(
    SANITY_CAP,
    Math.round(
      repos.reduce((sum, r) => {
        const base = MIN_PER_REPO + Math.ceil(r.openIssuesCount / 100) * PER_HUNDRED_ISSUES;
        return sum + base * Math.pow(PER_MONTH_MULT, opts.backfillMonths);
      }, 0),
    ),
  );
  const minutes = Math.ceil((requests / 4000) * 60);
  return { requests, minutes };
}
