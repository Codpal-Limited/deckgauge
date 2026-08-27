/**
 * Whether the OPERATOR has asked this deployment to behave as a pooled,
 * multi-tenant one.
 *
 * This is deliberately only HALF of `multiOrgEnabled` in
 * `organizations/organization.service.ts`, which is `DECKGAUGE_MULTI_ORG === 'true'
 * && features.includes('multi_org')`. The licence half cannot be read from here:
 * it is resolved asynchronously at boot and INJECTED into that service
 * (`entitledFeatures`), precisely so a test can state an entitlement with no
 * enterprise module on disk. `evaluatePolicy` receives `{ prisma, singleUser }`
 * and is called from the request path with no licence in reach.
 *
 * Reading the env half alone is safe **because of which way it errs**, and that
 * is the only reason it is acceptable:
 *
 *   - env set, licence WITHOUT `multi_org` → this returns true and the policy
 *     layer denies MORE than the cap strictly requires. `OrganizationService`
 *     still refuses to create a second organization, so the deployment holds one
 *     tenant and the only thing lost is the no-membership grant fallback — which
 *     is the hole. Failing towards deny is correct.
 *   - env unset, licence WITH `multi_org` → this returns false and the fallback
 *     stays as it is. Also safe: without the env half `bootstrap` enforces the
 *     one-organization cap, so there is no second tenant to cross into.
 *
 * So neither disagreement can open a cross-tenant path; one merely denies
 * slightly early. Were this used to ENABLE something rather than to deny, the
 * licence half would be mandatory and this file would be wrong.
 *
 * **The one case this does NOT cover, stated plainly because the argument above
 * is prospective and this one is temporal.** The reasoning holds while the flag
 * only ever moves from off to on. It does NOT hold if the flag goes from ON to
 * OFF on a deployment that has already created a second organization: the cap
 * lives in `bootstrap` and is not retroactive, so the tenants persist while this
 * function starts answering false, and every no-membership grant fallback
 * re-opens across them at once. Unsetting the variable is not a rollback — it is
 * a downgrade to single-tenant semantics on multi-tenant data.
 *
 * That is not hypothetical in this repo: `DECKGAUGE_MULTI_ORG` has previously
 * reached no container at all because `docker-compose.yml` whitelists env per
 * service, so "the operator did not intend to change this" and "the variable is
 * absent" are not the same event and cannot be distinguished from here.
 *
 * The robust fix is to make the deny conditional on the DATA rather than only the
 * declaration — `multiOrgOperatorEnabled() || (await organizationCount()) > 1` —
 * which cannot be switched off by an env regression. It is deliberately NOT done
 * here: it makes every call site do a database read, and it wants its own change
 * with its own tests rather than being smuggled into this one.
 *
 * **There are SIX call sites, and `grep -n 'multiOrgOperatorEnabled()'
 * apps/api/src/auth/policy.ts` is the enumeration to trust — not a count of policy
 * KINDS.** Two of the six are module-private helper functions rather than branches
 * of `evaluatePolicy`:
 *
 *   1. the `board` branch          4. the `employeeBoard` branch
 *   2. the `orgTree` branch        5. the `roadmap` branch
 *   3. `hasOrgTreeRole`            6. `hasComparisonRole`
 *
 * Whoever implements the durable fix must change all six. Counting kinds instead of
 * sites is exactly what hid `hasOrgTreeRole` through two review passes: it is
 * reached only from callers that contribute no board id, so the `board` branch's
 * own gate — which lives inside a loop over board ids — never runs on its paths.
 * `employeeBoardInTree` deliberately has no gate: it never had a no-membership
 * grant path to preserve.
 *
 * Until the durable fix lands, treat unsetting this variable on a
 * multi-organization deployment as unsupported, and see `planning/STATE.md`.
 *
 * Read per call rather than captured at import: the policy layer is exercised by
 * tests that flip the variable around a single case, and a module-level constant
 * would freeze whichever value the first import happened to see.
 */
export function multiOrgOperatorEnabled(): boolean {
  return process.env.DECKGAUGE_MULTI_ORG === 'true';
}
