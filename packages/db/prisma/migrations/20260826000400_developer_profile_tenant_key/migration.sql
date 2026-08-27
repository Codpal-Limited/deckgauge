-- developer_profiles gains its tenant key (tenancy §5b finding 1's residual).
--
-- The row holds engineer PII — provider, login, display_name, email — plus the
-- local user it maps to, and it had no organization_id. Its identity was the
-- deployment-global unique (provider, login), which is the same
-- per-host-not-per-deployment shape pr_jira_links had before
-- 20260820000300_pr_jira_link_tenant_key. Two defects fell out of it:
--
--   * a cross-tenant READ — the list route (ORG_ADMIN) had no WHERE at all, so
--     an administrator of one tenant read every tenant's logins and emails;
--   * a cross-tenant WRITE — the sync upserted on (provider, login), so two
--     organizations whose data contained the same login (one contractor, or any
--     common public login) shared ONE row and overwrote each other's PII.
--
-- Precondition 1 was closed naming only ClickHouse and PrJiraLink; this store
-- was resolved by CLASSIFICATION (§4.2 "class C — a login is a global fact")
-- rather than by a sweep. The classification is true of the LOGIN and false of
-- the ROW, which is a per-tenant assertion about one.

-- 1. Add nullable, so existing rows survive the statement.
ALTER TABLE "developer_profiles" ADD COLUMN "organization_id" TEXT;

-- 2. Backfill.
--
--    Unlike pr_jira_links there is NO join that identifies an owner: the row
--    carries only a provider login, an email and an optional user_id, and
--    user_id is null for almost every row (the mapping is what the ORG_ADMIN
--    route exists to create). user_id would be the wrong key even where it is
--    set — User is intentionally untenanted (§4.2 class C, and correctly so:
--    one person may hold memberships in several organizations), so it names no
--    single organization.
--
--    So the only defensible value is the sole organization, and this migration
--    REFUSES to guess when that premise does not hold. The enforced
--    one-organization cap (OrganizationService.bootstrap) is what makes the
--    premise true today; DECKGAUGE_MULTI_ORG is still unsupported, and §5's own
--    note is that the first second organization is the one-way door. If this
--    raises, the deployment already has rows that need a real provenance
--    decision, and silently attributing one tenant's engineers' PII to another
--    organization is strictly worse than failing the deploy.
DO $$
DECLARE
  org_count integer;
  profile_count integer;
  only_org text;
BEGIN
  SELECT count(*) INTO org_count FROM "organizations";
  SELECT count(*) INTO profile_count FROM "developer_profiles";

  IF profile_count = 0 THEN
    -- Nothing to attribute. A fresh install lands here, including one with no
    -- organization yet, and must not be blocked by the cardinality check.
    RETURN;
  END IF;

  IF org_count <> 1 THEN
    -- The recovery steps are spelled out because a bare re-run does NOT work.
    -- `prisma migrate deploy` reports this as P3018 and records the migration as
    -- FAILED, so the next invocation stops at P3009 ("migrate found failed
    -- migrations in the target database") without ever reaching this block. The
    -- `migrate resolve --rolled-back` is what clears that record. Safe to do,
    -- and verified: after P3018 the column does not exist and
    -- `applied_steps_count` is 0, so nothing above this point was applied and
    -- the non-idempotent `ADD COLUMN` / `CREATE UNIQUE INDEX` below re-run
    -- cleanly.
    RAISE EXCEPTION
      'developer_profiles backfill needs exactly one organization to attribute % untenanted profile row(s) to; found %. These rows carry engineer PII and no column that identifies an owner, so this migration will not guess. To recover: (1) attribute the rows by hand, or reduce to one organization; (2) run `prisma migrate resolve --rolled-back 20260826000400_developer_profile_tenant_key` -- without this a re-run fails with P3009, because this failure is recorded as a failed migration; (3) re-run `prisma migrate deploy`.',
      profile_count, org_count;
  END IF;

  SELECT "id" INTO only_org FROM "organizations";
  UPDATE "developer_profiles" SET "organization_id" = only_org WHERE "organization_id" IS NULL;
END $$;

-- 3. Belt-and-braces: the block above either attributed every row or raised, so
--    this can only fire if that reasoning is wrong. Raise rather than DELETE
--    (which is what pr_jira_links did) — those links regenerate from live GitHub
--    data on the next sync, whereas a developer profile carries the hand-made
--    user mapping and cannot be reconstructed.
DO $$
DECLARE
  orphans integer;
BEGIN
  SELECT count(*) INTO orphans FROM "developer_profiles" WHERE "organization_id" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'developer_profiles: % row(s) still have no organization_id after backfill', orphans;
  END IF;
END $$;

ALTER TABLE "developer_profiles" ALTER COLUMN "organization_id" SET NOT NULL;

-- 4. Swap the unique key so the tenant is part of identity — this is the half
--    that stops two tenants' identically-keyed rows overwriting each other —
--    and re-index the two lookup columns behind it so a future reader cannot
--    scan across tenants.
--
--    No collision is possible at this point: every row was attributed to the
--    SAME organization, and the old global unique already guaranteed
--    (provider, login) was distinct.
DROP INDEX IF EXISTS "developer_profiles_provider_login_key";
DROP INDEX IF EXISTS "developer_profiles_user_id_idx";
DROP INDEX IF EXISTS "developer_profiles_email_idx";

CREATE UNIQUE INDEX "developer_profiles_organization_id_provider_login_key"
    ON "developer_profiles"("organization_id", "provider", "login");
CREATE INDEX "developer_profiles_organization_id_user_id_idx"
    ON "developer_profiles"("organization_id", "user_id");
CREATE INDEX "developer_profiles_organization_id_email_idx"
    ON "developer_profiles"("organization_id", "email");

ALTER TABLE "developer_profiles"
    ADD CONSTRAINT "developer_profiles_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
