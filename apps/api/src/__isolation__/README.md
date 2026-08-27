# The isolation harness

Slice 4 of `docs/superpowers/specs/2026-08-17-hosted-saas-program-design.md`.
Its job is stated in §9: *"Proof, before anything below is trusted"* — and it is
sequenced before the slices that close the holes **deliberately**, so that closing
each one is demonstrated rather than asserted.

Everything here is an adversarial cross-tenant test. Nothing here is a unit test
for a feature.

## Provenance — read this before trusting a comment in here

This directory was written on a four-branch stack (`isolation-harness` →
`pg-leak-closure` → `ch-read-identity` → `ch-read-adoption`) that fell ~102
commits behind `main` and had its entire production half superseded while it sat.
`main` shipped the same capability independently: the 6d slices (2026-08-21), the
"chokepoint was inert" fix (`e6dcd9fc`, 2026-08-23), and a provisioned and
verified ClickHouse read identity (item 6e, `a0c20d12`, 2026-08-24).

**These tests are the only part of that stack that was worth keeping**, and they
were re-verified against `main` on 2026-08-26 rather than carried over on trust.
Two things had rotted and are corrected here:

- the ClickHouse read identity was **unprovisioned** when this was written, and
  the old text said so at length. It is provisioned now, so the alarm is gone and
  what remains is a regression guard. See `planning/STATE.md`, item 6e.
- `ch-read-adoption.test.ts` pointed readers at a `chReaderFactory` that **has
  never existed on `main`**. The real chokepoint is `request.chRead`.

Everything the stack's *production* code did is gone. Do not go looking for
`packages/db/src/clickhouse-read.ts` — it was that stack's version of the read
helper and it lost the race to `apps/api/src/analytics/ch-read-*.ts`.

## Why these tests are allowed to be red

`it.fails(...)` marks a hole that is **still open**. The body asserts the SAFE
behaviour — the behaviour a pooled deployment needs — and `it.fails` records that
it does not hold yet. So:

- the suite is green while the hole is open, and says why in its name;
- the moment someone closes the hole, `it.fails` starts FAILING, because the test
  it wraps began passing. Whoever closed it must flip `it.fails` → `it` and strike
  the row from the table below.

That is the point. A skipped test rots quietly; a `TODO` rots quietly. This
cannot: the harness breaks when reality improves, and the only way to quiet it is
to record that reality improved.

**Never delete an `it.fails` to make a build green.** It is the record that the
hole is real, and it is load-bearing for slices 5, 6 and 7.

There were exactly **three** of them, all in `policy-cross-tenant.test.ts`.
**As of 2026-08-26 (slice 5) there are none left** — all three were flipped to
`it` because the holes they recorded were closed, which is the mechanism working
as designed rather than a hole being forgotten. Each carries, in place of its old
"STILL OPEN" note, what closed it and what the closure does NOT cover. The
directory is now entirely regression guards.

The mechanism is therefore currently unexercised. If a future slice opens a new
hole, add an `it.fails` back and re-add a row to the table below.

**2026-08-27 — still zero, and for the right reason.** A latent-hardening pass
closed the two remaining "contributes nothing → ALLOW on an empty set" constructs
(`then: 'authenticated'` and `board(role, [])`) and pinned them in
`policy-cross-tenant.test.ts`. Neither had a production call site, so neither was
a hole and neither warranted an `it.fails` — the rule is that an `it.fails` records
a hole that is **still open**, and these are closed. What they are is *regression
guards on constructs that were never reachable*, which is a category this directory
did not previously hold and is worth naming: the shape had been mis-declared closed
twice, so an unreachable construct with the shape of a live hole is pinned rather
than argued about.

**Zero `it.fails` is only honest if zero holes are open.** The first pass of slice 5
left that untrue: it closed two of hole 3's six sites while the records claimed the
hole was closed, so the harness was quiet about four live cross-tenant paths. All
six are now closed and pinned, so the count is zero for the right reason. If you
ever conclude a hole must STAY open, an `it.fails` is the required output — not a
comment, and not silence.

## Standing rule

Every hole below is **inert under the enforced one-organization cap**
(`OrganizationService.bootstrap`). That cap is not something to work around — it
is the safety rail that makes the holes unreachable, and §9 is explicit that
nothing before slice 7 may lift it. These tests reach the holes by constructing
two organizations directly, below the cap.

## Current state of the four documented holes

Verified against the code on **2026-08-26**, not taken from the design doc — which
is stale in both directions.

| § | Hole | State |
|---|---|---|
| 4.1 (1) | Connection service reads unscoped, incl. `getRawById` returning a live provider token | **CLOSED.** The raw getters now take a `ConnectionCaller` and filter on `caller.organizationId`. Guarded here against regression. |
| 4.1 (2) | `evaluatePolicy`'s board branch falls back to the grant alone when there is no membership | **CLOSED in slice 5 — IN THE POLICY LAYER, at all six sites that decide on a bare grant with no membership.** Scoped deliberately: this row is a claim about `auth/policy.ts`, not about every read in the codebase (route handlers that read unscoped are tracked separately). The fallback now denies, GATED on `DECKGAUGE_MULTI_ORG` (env half only; `auth/multi-org-flag.ts` explains why that is the safe half to read here), so single-tenant behaviour is unchanged and ~140 pre-existing `policy.test.ts` cases that omit `membership` still pass. The design names only the BOARD branch; the invariant is kind-agnostic, so the gate covers `orgTree`, `comparison`, `employeeBoard`, `roadmap` **and `hasOrgTreeRole`**. That last was missed in both earlier passes and is the instructive one: it is reached ONLY from callers contributing no board id (the `upload` hop returns `ORG_OK`, the `orgEntity` arm adds nothing), so `resolveBoardIds` answers `[]`, the `board` branch's id loop runs zero times, and the gate living inside that loop never executes — a per-kind count hides it. `employeeBoardInTree` needs no gate: it never had a no-membership grant path. **Two things NOT closed:** grants already orphaned by removals predating the revoke (not retroactive — audit query in `planning/STATE.md`), and the flag going ON→OFF on a deployment already holding 2+ organizations, which re-opens every fallback at once (`auth/multi-org-flag.ts`; the durable fix is to gate on `organizationCount() > 1` too). |
| 4.1 (3) | `users.is_admin` / realm role are instance-level, not tenant-scoped | **CLOSED in slice 5, unconditionally, at SIX sites.** The design names one; there were six, all the same `if (ctx.isAdmin) return ALLOW` shape reached with `membership: null`, all over data carrying an `organization_id`: the `orgTree` branch, `hasOrgTreeRole`, `hasComparisonRole`, the `employeeBoard` branch, `employeeBoardInTree`, and the `roadmap` branch. The two worst are the ones reached from INSIDE board-source resolution — `hasOrgTreeRole` (`then: 'orgEntity'`) and `hasComparisonRole` (`then: 'comparisonAccess'`) — because those arms contribute no board ids, so the id loop never runs and `evaluatePolicy` returns ALLOW on an empty set with nothing downstream re-checking. **Closing the last four broke no existing test: they had no coverage at all.** `policy.kind === 'admin'` deliberately still honours the signal — it RETURNS no tenant data, which is the distinction. Precise wording matters here: some ADMIN routes DO act across tenants (`POST /intelligence/sync` enqueues sync work for all of them), but none hand the caller another tenant's rows, so break-glass there cannot be used to READ across the boundary. An ADMIN route that returned per-tenant rows would break that and belongs on an entity policy instead. Lockout recovery is bootstrap-adopt. |
| 4.2 | ClickHouse analytics are un-tenanted | **CLOSED in code and in staging.** Column + row policies landed, and the read identity that makes them mean anything is provisioned and verified (item 6e). Two route plugins still read unscoped — ratcheted, not asserted. |

## §4.2 is stale, and the correction matters

The design says ClickHouse contains *"no `organization_id` column in any of the
20+ tables"*, and prescribes injecting a tenant predicate into
`intelligence-query/scope/` at the execution boundary.

**Neither half of that is the current design.** All 23 real schema files carry
`organization_id`, first in the sorting key. And tenancy is enforced not in the
query layer at all but by **ClickHouse row policies**, activated by a
request-level `role` parameter — see `apps/api/src/analytics/ch-read-scope.ts` and
`packages/db/src/ch-row-policies.ts`.

So the fact that **0 of 35 builders mention `organization_id`** is not a defect.
It is the point: the boundary lives in one audited place, and it **fails closed**.
`deny_uncovered … USING 0 TO ALL` covers every object, each organization's
`iso_org_<id> … USING organization_id = '<id>'` re-admits only its own rows to its
own role, and a query that activates no role therefore returns nothing. A
forgotten scope is a blank widget — visible and reported — not a leak. That is
strictly better than thirty hand-maintained `WHERE` clauses, which is what §4.2
was trying to avoid.

The role is also unforgeable from SQL: `role` is a request parameter, not a
setting, so `SETTINGS role='org_b'` is `Code 115 UNKNOWN_SETTING` and
`SET ROLE …; SELECT …` is `Code 62`. Only the process building the request picks
it.

### The one silent failure mode — closed, and worth keeping in view

Row policies are **OR'd**. So a single permissive `USING 1` attached directly to
the identity doing the reading does not weaken the boundary, it removes it: an
`iso_` predicate OR'd with `USING 1` matches every row, so **an activated role
stops narrowing anything**.

> **Do not shorten that to "every `role=` on that identity becomes a no-op."** That
> phrasing was in six places in this repo and it is false about the ingest identity,
> which is granted no organization role and therefore cannot activate one:
> ClickHouse answers `Code 512 SET_NON_GRANTED_ROLE` (or `511 UNKNOWN_ROLE` for a
> name that does not exist). Two separate facts get merged by that wording — a
> permissive policy defeats an **activated** role's predicate, and says nothing
> about whether the role may be **activated**. Believing the merged version shipped
> a read fallback that threw on every query in both apps, on every default install
> (2026-08-27; see `planning/STATE.md`). `clickhouse-row-policy.int.test.ts` has
> asserted the true behaviour all along in "the reader cannot activate a role it was
> never granted".

That is exactly what the ingest identity carries. `ingestIdentityDdl` grants
`ingest_all … USING 1` on every object, because the worker ingests for every
organization from one queue — correct for a writer, fatal for a reader. Which is
why the design calls for a **separate API read identity** holding
`DEFAULT ROLE NONE` plus a grant of each organization's role.

**That split is now provisioned.** When this file was first written it was not,
and the original text ran to two screens of evidence that staging read as
`cockpit` with `ingest_all` governing. That is fixed; the detail lives in
`planning/STATE.md` under *"Staging's ClickHouse read identity is provisioned and
verified (item 6e)"*, 2026-08-24:

| Probe | Result |
|---|---|
| `reader`, no role activated | 0 rows — fails closed |
| `reader`, org role activated | the tenant's own data |
| `reader` `default_roles_all` | 0 |
| Dashboard load, `system.query_log` | 39 queries by `reader`, 0 real analytics reads by `cockpit` |

One retrofit trap recorded there is worth repeating, because a fresh-stack
rehearsal cannot reproduce it: after creating the reader its granted-roles list was
**empty**, because `provisionOrganizationAnalytics` grants the org role at
provisioning time and staging's organization predated the reader. A reader holding
no grant activates nothing and every dashboard goes blank.

One dead end worth recording so nobody repeats it: **the read identity cannot be
shipped as a `clickhouse/users.d/*.xml` file.** A user defined in XML lives in the
`users_xml` storage, which is read-only at runtime, so provisioning's
`GRANT <role> TO <user>` and `SET DEFAULT ROLE NONE TO <user>` fail with `Code
495 … this storage is readonly`. It has to be a SQL-managed login created out of
band.

## One hole was worse than the design records — CLOSED in slice 5

**Everything in this section is history as of 2026-08-26.** `MembershipService.remove`
now revokes, inside its existing transaction, every grant the departing member held
in the organization being left — across all five kinds in `ACCESS_ENTITIES`, not
just boards (`apps/api/src/access/revoke-grants.ts`), and scoped to that one
organization so a membership held elsewhere survives. Pinned against a real
Postgres in `organizations/membership.service.test.ts`. The paragraph below is kept
because the diagnosis is still the clearest statement of why a cascade could never
have covered it.



`MembershipService.remove` deletes the `OrgMembership` row and nothing else — no
`BoardAccess` cleanup, and no cascade in the schema. Combined with hole 2, that
means **removing someone from an organization does not end their board access**:
their next request resolves `membership: null`, lands on the no-membership
fallback, and their stale grant decides alone, at the role it grants.

A cascade could not fix this even in principle: `BoardAccess` is keyed
`(boardId, userId)` and holds no foreign key to `OrgMembership`, so there is no
relation for `onDelete` to travel along. Closing it needs an explicit revoke in
`remove`, or a membership join on the fallback read.

This did not need multi-org to bite — it was reachable in the single-tenant
product. The web app redirects a membership-less caller to `/no-organization`, so
it was invisible through the UI and entirely reachable with a token. **Closed
2026-08-26**; the revoke is pinned in `organizations/membership.service.test.ts`,
against a real Postgres because the predicate that makes it correct is exactly the
kind a hand-written double lets pass while wrong.

One correction worth carrying forward, because a comment elsewhere still asserts
the opposite: `MembershipService.resolveForUser`'s docstring says a null membership
becomes "403 NO_ORGANIZATION" at the auth plugin. **It does not.** The plugin's own
comment is explicit that "'No membership at all' … deliberately does NOT deny",
since a first-run admin has none by definition. That is why these no-membership
paths are reachable at all. The docstring is stale; do not trust it.

## Files

- `policy-cross-tenant.test.ts` — §4.1 holes 2 and 3, plus regression guards on
  the halves closed earlier. It held **all three `it.fails` in this directory**;
  since slice 5 it holds none, and each of those three cases now records what
  closed it. The two board cases call `withMultiOrg()`, because hole 2's deny is
  flag-gated and their doubles return a grant row — so the revoke cannot make them
  pass and only the fallback change can. That caveat is stated in the test bodies.
  It also carries a **hole 3b** section: `hasOrgTreeRole` compares the tree's
  `organizationId` as of 2026-08-26, so an org ADMIN of one tenant is no longer
  OWNER-equivalent on another tenant's org tree. Its "the no-membership break-glass
  path is unchanged" block is now "…is confined" — slice 5 removed that
  short-circuit too, since it was the second door onto hole 3.

  Since 2026-08-27 it also carries a section on **the mechanism itself** rather
  than on a hole — *"the empty-board-id-set mechanism — the two constructs that
  gated nothing"*. The rule it pins: an ALLOW out of the `board` branch must be
  backed by a check that actually ran, so a construct that can leave the resolved
  set empty either does its own check or is refused. `then: 'authenticated'` is
  gone from `BoardBranch` and refused at runtime; `board(role, [])` is refused on
  the source list. Both carry a precision pair — the LEGITIMATE empty-set path
  (`orgEntity`, checked inside the arm) must still ALLOW — because a guard written
  as "deny on an empty resolved set" passes every deny case and breaks that one.
- `credential-boundary.test.ts` — §4.1 hole 1, CLOSED. Regression guard only.
  Every caller in it is an org ADMIN on purpose, so `visibleConnectionWhere`
  contributes nothing and a failure can only mean the TENANT filter is gone.
- `clickhouse-read-identity.test.ts` — §4.2. Guards the scoped reader's contract,
  which is the part of the ClickHouse boundary that lives in code. No ClickHouse
  needed. Overlaps `analytics/ch-read-scope.test.ts` deliberately; the case unique
  to here is the refusal to build a reader with a blank organization id.
- `clickhouse-row-policy.int.test.ts` — §4.2 / tenancy D3, **proven end to end**
  against a real ClickHouse using the real provisioning DDL: a role-scoped reader
  sees one organization, a roleless read is refused, an ungranted role cannot be
  activated, and the ingest identity reads every tenant. Skips with a reason when
  access management is unavailable.
- `ch-read-adoption.test.ts` — a ratchet on which route plugins still read
  ClickHouse unscoped. The list is now **EMPTY**: `advisor.routes.ts` and
  `mcp.routes.ts` were the last two and both build their service per request
  from `request.chRead`. Keep the list and both its assertions — with nothing
  declared, the first one is what makes a NEW unscoped read route fail. Its
  check was also hardened at the same time: it used to pass on any mention of
  the token `chRead`, which the routes' own comments satisfied, so a reversion
  to the ingest client could hide behind a comment. It now strips comments and
  requires a real property access. The query console is still EXEMPT rather than
  listed — provisioning grants it no per-organization role, so it awaits a
  design decision, not a mechanical migration.

## Running it

The two pure-code files need nothing. The rest need the test stack:

```bash
docker compose -p vp-cockpit-test -f docker-compose.test.yml up -d
pnpm --filter @deckgauge/api test -- src/__isolation__
```

`clickhouse-row-policy.int.test.ts` needs `CREATE ROW POLICY` / `CREATE ROLE`,
which is why `docker-compose.test.yml` sets
`CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: 1`. **That flag carries a footgun**: the
image's entrypoint applies it by rewriting the mounted
`clickhouse/users.d/default-user.xml`, which is a TRACKED file — so starting the
test stack dirties your working tree, and `git checkout`ing it back while the
container runs silently revokes the grant from the running server. The test
detects that and skips with an explanation rather than failing, because failing
there would blame the test for a stale checkout.

## The mechanism was verified, not assumed

`it.fails` was checked against a body that passes: it fails, loudly. So the claim
above — that closing a hole breaks this suite — is tested behaviour, not a hope
about how vitest works.
