import { unavailable, type PageStateArgs, type PageStateDeps, type PageStateResult } from './page-state.types.js';
import { resolveOrgPageState } from './org-page-state.js';
import { resolveRoadmapPageState } from './roadmap-page-state.js';
import { resolveSourcesPageState } from './sources-page-state.js';
import { resolveTimesheetPageState } from './timesheet-page-state.js';

/**
 * Page key → resolver. Keys are the `key` values from the web's
 * `advisor-page-context.ts`, which the client already sends and the route
 * already validates — the model never supplies one.
 *
 * A page absent from this map is not an error; it simply has no live state
 * worth reading, and the corpus answers it. `comparison` is deliberately
 * absent: a comparison spans several boards while the request authorizes
 * exactly one, so `available: false` is the honest outcome rather than
 * inventing an authorization path.
 */
type Resolver = (deps: PageStateDeps, args: PageStateArgs) => Promise<PageStateResult>;

/**
 * A `Map`, not an object literal. `pageKey` originates in a request body
 * (`pageContext.key`, only `z.string().min(1)` in `packages/shared/src/advisor.ts`),
 * so any authenticated user can choose it — and bracket lookup on an object
 * literal walks `Object.prototype`, so `constructor` resolved to `Object` and
 * `Object(deps, args)` RETURNED `deps`, handing the live `PrismaClient` back as
 * the tool result; `toString` resolved to a function returning
 * `"[object Undefined]"`, presented to the model as this instance's
 * configuration.
 *
 * A `Map` fixes that structurally rather than by discipline: `Map.get` never
 * consults a prototype chain, so no inherited member can ever resolve, and a
 * future edit cannot silently reintroduce the hole the way removing a
 * `hasOwnProperty` guard from a lookup site would. Validating against
 * `MAPPED_PAGE_KEYS` was the other candidate and was rejected for the same
 * reason: it leaves the unsafe lookup in place behind a separate check.
 */
const RESOLVERS: ReadonlyMap<string, Resolver> = new Map<string, Resolver>([
  ['timesheet', resolveTimesheetPageState],
  ['timesheet-statuses', resolveTimesheetPageState],
  ['sources', resolveSourcesPageState],
  ['connections', resolveSourcesPageState],
  ['roadmap', resolveRoadmapPageState],
  ['org', resolveOrgPageState],
]);

/**
 * The keys actually wired to a resolver. Exported so the regression test can
 * assert the exact set against a literal expected list — catching both a
 * key added here without a matching test update, and a key silently
 * dropped from this map — rather than deriving its own expectation from
 * this same map, which would catch neither.
 */
export const MAPPED_PAGE_KEYS: readonly string[] = [...RESOLVERS.keys()];

/**
 * Whether a page key has a resolver at all. The route uses this to decide
 * whether to offer `get_page_state` in the first place: on an unmapped page the
 * tool could only ever answer "not mapped", so offering it invites a per-question
 * tool round trip that buys nothing — and keeping it off those pages also keeps
 * the dispatcher out of reach of a request-supplied key entirely.
 */
export function isMappedPageKey(pageKey: string): boolean {
  return RESOLVERS.has(pageKey);
}

/**
 * The reason returned for a page key with no resolver. Exported so the test
 * can assert against the real message instead of a hand-copied fragment —
 * a prior version of this string drifted from a regex written in the task
 * brief for an earlier draft, leaving that regex unable to ever match.
 */
export function unmappedPageReason(pageKey: string): string {
  return `The ${pageKey} screen is not mapped to any live configuration this tool can cover; answer from the documentation instead.`;
}

export async function resolvePageState(
  pageKey: string,
  deps: PageStateDeps,
  args: PageStateArgs = {},
): Promise<PageStateResult> {
  const resolver = RESOLVERS.get(pageKey);
  if (!resolver) {
    return unavailable(unmappedPageReason(pageKey));
  }
  return resolver(deps, args);
}
