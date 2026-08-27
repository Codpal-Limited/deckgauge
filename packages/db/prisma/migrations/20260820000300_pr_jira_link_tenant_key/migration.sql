-- pr_jira_links gains its tenant key (tenancy §11 precondition 1).
--
-- `pr_id` is the synthetic "<repo_full_name>#<pr_number>", not a row id, so two
-- organizations syncing the same repository produced the identical pr_id. The old
-- unique key (pr_id, jira_key, source) then made their rows collide, and the
-- linker's deleteMany-by-pr_id let whichever tenant synced last destroy the
-- other's links using its OWN Jira project-key regex. A cross-tenant write.

-- 1. Add nullable, so existing rows survive the statement.
ALTER TABLE "pr_jira_links" ADD COLUMN "organization_id" TEXT;

-- 2. Backfill through the only path that identifies an owner:
--    repo_full_name -> github_repo_syncs -> github_instances.organization_id.
--    Verified before writing this migration: 2692 of 2692 rows resolve, and no
--    repository is synced by more than one organization, so the join is
--    unambiguous. `MIN` is belt-and-braces for a future where it is not.
UPDATE "pr_jira_links" l
   SET "organization_id" = sub.organization_id
  FROM (
    SELECT s."repo_full_name", MIN(i."organization_id") AS organization_id
      FROM "github_repo_syncs" s
      JOIN "github_instances" i ON i."id" = s."github_instance_id"
     GROUP BY s."repo_full_name"
  ) sub
 WHERE l."repo_full_name" = sub."repo_full_name";

-- 3. Anything still NULL has no resolvable owner — its repository sync is gone,
--    so its provenance is already lost. Delete rather than keep an untenanted
--    row: the linker upserts from live GitHub data, so a still-synced repo
--    regenerates its links on the next run, and a no-longer-synced one should
--    not keep rows nobody can scope. Expected to delete 0 here.
DELETE FROM "pr_jira_links" WHERE "organization_id" IS NULL;

ALTER TABLE "pr_jira_links" ALTER COLUMN "organization_id" SET NOT NULL;

-- 4. Swap the unique key so the tenant is part of identity, and re-index the two
--    lookup columns behind it so a future reader cannot scan across tenants.
DROP INDEX IF EXISTS "pr_jira_links_pr_id_jira_key_source_key";
DROP INDEX IF EXISTS "pr_jira_links_jira_key_idx";
DROP INDEX IF EXISTS "pr_jira_links_repo_full_name_idx";

CREATE UNIQUE INDEX "pr_jira_links_organization_id_pr_id_jira_key_source_key"
    ON "pr_jira_links"("organization_id", "pr_id", "jira_key", "source");
CREATE INDEX "pr_jira_links_organization_id_jira_key_idx"
    ON "pr_jira_links"("organization_id", "jira_key");
CREATE INDEX "pr_jira_links_organization_id_repo_full_name_idx"
    ON "pr_jira_links"("organization_id", "repo_full_name");

ALTER TABLE "pr_jira_links"
    ADD CONSTRAINT "pr_jira_links_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
