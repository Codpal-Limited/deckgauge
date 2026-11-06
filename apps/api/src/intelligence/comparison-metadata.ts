// P6 — Comparability metadata for multi-board comparison widgets.
//
// When a VP lines up teams that live on different boards, some metrics are
// apples-to-apples across those boards and some are not. Rate/duration metrics
// (review coverage %, cycle time, comment rate) are self-normalising and stay
// comparable. Raw counts (issues delivered, PRs merged) and PR-size buckets are
// NOT comparable once the board set mixes issue/PR providers, because Jira and
// ADO count and slice work differently (squash vs merge commits, story vs task
// granularity, XS-heavy PR-size skew). The web layer greys the non-comparable
// cells so the reader never misreads e.g. Acme's raw PR count against a
// squash-only ADO team.
//
// A per-capita metric (a count divided by effective-developer headcount) is
// comparable ONLY when every board in the set has a resolvable org-tree link;
// a board with no org roster has no denominator and is flagged instead of
// silently dividing by the raw member list.

import type { BoardScope } from './board-scope.js';

export interface ComparabilityFlag {
  comparable: boolean;
  reason?: string;
}

export const COUNTS_ACROSS_PROVIDERS_REASON = 'counts not comparable across Jira/ADO';
export const MISSING_ORG_LINK_REASON = 'no org-tree link on one or more boards';

interface ScopeLike {
  scope: Pick<
    BoardScope,
    | 'jiraProjectKeys'
    | 'adoProjects'
    | 'githubRepoFullNames'
    | 'gitlabProjectPaths'
    | 'bitbucketRepoFullNames'
  >;
}

/**
 * The distinct provider families a single board draws from. A board scoped to
 * both Jira (issues) and GitHub (PRs) counts as both — that's normal within one
 * board and does NOT itself make the set non-comparable.
 */
function providerFamilies(scope: ScopeLike['scope']): Set<string> {
  const set = new Set<string>();
  if (scope.jiraProjectKeys.length > 0) set.add('jira');
  if (scope.adoProjects.length > 0) set.add('ado');
  if (scope.githubRepoFullNames.length > 0) set.add('github');
  if (scope.gitlabProjectPaths.length > 0) set.add('gitlab');
  if ((scope.bitbucketRepoFullNames ?? []).length > 0) set.add('bitbucket');
  return set;
}

/**
 * True when the compared board set spans more than one provider family across
 * boards (e.g. one board's work lives in Jira/GitHub and another's in ADO).
 * Raw counts and PR-size buckets across such a set are not comparable, since
 * Jira and ADO count and slice work differently.
 */
export function boardSetMixesProviders(entries: ReadonlyArray<ScopeLike>): boolean {
  const all = new Set<string>();
  for (const e of entries) {
    for (const fam of providerFamilies(e.scope)) all.add(fam);
  }
  return all.size > 1;
}

/** Comparability flag for a raw-count / PR-size metric given the board set. */
export function countMetricComparability(
  entries: ReadonlyArray<ScopeLike>
): ComparabilityFlag {
  return boardSetMixesProviders(entries)
    ? { comparable: false, reason: COUNTS_ACROSS_PROVIDERS_REASON }
    : { comparable: true };
}

/** A rate / duration metric is always comparable across boards. */
export function rateMetricComparability(): ComparabilityFlag {
  return { comparable: true };
}

/**
 * Comparability flag for a per-capita metric. Comparable only when every board
 * resolved a non-null effective-developer headcount (i.e. has an org-tree link).
 */
export function perCapitaComparability(
  headcounts: ReadonlyArray<number | null>
): ComparabilityFlag {
  const allLinked = headcounts.length > 0 && headcounts.every((h) => h !== null && h > 0);
  return allLinked ? { comparable: true } : { comparable: false, reason: MISSING_ORG_LINK_REASON };
}
