-- sync_runs gains its tenant key (tenancy §11 precondition 1).
--
-- The FOURTH class-D store, after ClickHouse and pr_jira_links (which is all
-- precondition 1 ever named) and developer_profiles
-- (20260826000400_developer_profile_tenant_key). Same method note as §5a/§5b:
-- the precondition was marked closed against a written LIST, and this store was
-- on no list.
--
-- What leaked. `GET /github/sync/status` and `GET /azure-devops/sync/status` both
-- ran on the `AUTHENTICATED` policy — which resolves no membership and no
-- tenant — and both handlers took `_req`, ignoring the caller entirely. Their
-- service reads filtered on `source` alone:
--
--     syncRun.findFirst({ where: { source: 'github' }, orderBy: { startedAt: 'desc' } })
--
-- so every authenticated caller in the deployment received the DEPLOYMENT's
-- newest run. `errorMessage` is the provider's failure text verbatim; the
-- staging table's own rows include
--
--     'Azure DevOps API error: 404 — TF200016: The following project does not
--      exist: «redacted». …'
--
-- which is a private ADO team project name. A tenant with no connection at all
-- was shown a neighbour's failure rather than NEVER.
--
-- 1. Add nullable, so existing rows survive the statement.
ALTER TABLE "sync_runs" ADD COLUMN "organization_id" TEXT;

-- 2. Backfill.
--
--    There is NO join that identifies an owner, and unlike pr_jira_links this is
--    not a matter of a missing parent row — the table has no attributable column
--    at all:
--
--      * the four `*SyncId` columns (jira_project_sync_id, github_repo_sync_id,
--        azure_devops_project_sync_id, gitlab_project_sync_id) WOULD have
--        identified one, and they are DEAD. They were added for Phase 3 and no
--        code path has ever written one. Verified two ways before writing this:
--        by sweeping every `syncRun.create`/`syncRun.update` call site in apps/
--        and packages/ (all three writers set only status, trigger, startedAt and
--        source), and against the staging table — 4982 rows, and 0 non-null in
--        each of the four columns.
--      * `source` names a PROVIDER ('jira' | 'github' | 'azure-devops'), not an
--        owner, and several tenants may each have a connection to the same one.
--
--    So the only defensible value is the sole organization, and this migration
--    REFUSES to guess when that premise does not hold — the same choice
--    20260826000400 made, for the same reason: silently attributing one tenant's
--    outage history and private source names to another organization is strictly
--    worse than failing the deploy. The enforced one-organization cap
--    (OrganizationService.bootstrap) is what makes the premise true today;
--    DECKGAUGE_MULTI_ORG remains unsupported.
--
--    If this RAISES, recovery is three steps, not one — `prisma migrate deploy`
--    leaves the migration recorded as failed, so a bare re-run does NOT retry it:
--
--      1. attribute the rows by hand, or delete them (see the note below on why
--         deleting is acceptable HERE and was not for developer_profiles);
--      2. `pnpm --filter @deckgauge/db exec prisma migrate resolve \
--            --rolled-back 20260826000500_sync_run_tenant_key`
--         — without this, step 3 answers P3009 ("migrations failed") having
--         already answered P3018 on the raise;
--      3. `pnpm --filter @deckgauge/db migrate:deploy`.
--
--    Deleting is a legitimate resolution for THIS table where it was not for
--    developer_profiles: a sync run is an append-only observation with a 7-day
--    retention job already deleting it (`pruneSyncRuns` in apps/worker/src/index.ts),
--    and it holds no hand-made mapping that cannot be reconstructed. It is offered
--    as an operator choice rather than done automatically, because the rows are
--    the only record of a failed sync and an operator may be mid-investigation.
DO $$
DECLARE
  org_count integer;
  run_count integer;
  only_org text;
BEGIN
  SELECT count(*) INTO org_count FROM "organizations";
  SELECT count(*) INTO run_count FROM "sync_runs";

  IF run_count = 0 THEN
    -- Nothing to attribute. A fresh install lands here, including one with no
    -- organization yet, and must not be blocked by the cardinality check.
    RETURN;
  END IF;

  IF org_count <> 1 THEN
    RAISE EXCEPTION
      'sync_runs backfill needs exactly one organization to attribute % untenanted sync run row(s) to; found %. These rows carry provider failure text that names private repositories and team projects, and the table has no column that identifies an owner (all four *_sync_id columns are unwritten). This migration will not guess. Attribute or delete them by hand, then run `prisma migrate resolve --rolled-back 20260826000500_sync_run_tenant_key` before re-running migrate deploy — a bare re-run answers P3009.',
      run_count, org_count;
  END IF;

  SELECT "id" INTO only_org FROM "organizations";
  UPDATE "sync_runs" SET "organization_id" = only_org WHERE "organization_id" IS NULL;
END $$;

-- 3. Belt-and-braces: the block above either attributed every row or raised, so
--    this can only fire if that reasoning is wrong. Raise rather than DELETE —
--    a silent delete here would destroy the only record of a failed sync, and an
--    operator who wants that outcome can choose it explicitly per the note above.
DO $$
DECLARE
  orphans integer;
BEGIN
  SELECT count(*) INTO orphans FROM "sync_runs" WHERE "organization_id" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'sync_runs: % row(s) still have no organization_id after backfill. Run `prisma migrate resolve --rolled-back 20260826000500_sync_run_tenant_key` before re-running migrate deploy.',
      orphans;
  END IF;
END $$;

ALTER TABLE "sync_runs" ALTER COLUMN "organization_id" SET NOT NULL;

-- 4. Re-index behind the tenant.
--
--    There is no unique key to swap here — unlike pr_jira_links and
--    developer_profiles, sync_runs is keyed by a generated uuid, so no two
--    tenants' rows could ever have collided. This store was a pure cross-tenant
--    READ, not the collision shape. What matters is that the one read of this
--    table cannot scan across tenants: it is
--    `where { organization_id, source } order by "startedAt" desc`, which the
--    first index below serves exactly, tenant column first.
DROP INDEX IF EXISTS "sync_runs_status_idx";

CREATE INDEX "sync_runs_organization_id_source_startedAt_idx"
    ON "sync_runs"("organization_id", "source", "startedAt");
CREATE INDEX "sync_runs_organization_id_status_idx"
    ON "sync_runs"("organization_id", "status");

--    "sync_runs_startedAt_idx" is deliberately KEPT and deliberately tenant-free:
--    the worker's daily retention job deletes every organization's runs older
--    than 7 days in one statement, and that scan is deployment-wide by design.
--    Prefixing it with the tenant would make the only cross-tenant thing about
--    this table slower for no boundary gained.

ALTER TABLE "sync_runs"
    ADD CONSTRAINT "sync_runs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
