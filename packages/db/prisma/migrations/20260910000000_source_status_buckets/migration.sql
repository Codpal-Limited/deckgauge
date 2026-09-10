-- One decision per (issue source, status name): what that status MEANS.
--
-- Keyed on the SOURCE rather than a board or an org tree. A status belongs to a
-- workflow and a workflow belongs to a project, so the source is where the fact
-- lives — and it is the only key both consumers can reach. The timesheet is
-- scoped per org tree (a set of people), Team Focus per board (a set of work);
-- neither contains the other, and neither is where a status comes from.
--
-- Nothing reads this table yet. It is populated and consumed in the next slice,
-- where `active_statuses` becomes derived from the IN_PROGRESS rows — which is
-- also where 16 statuses stop counting as engineer labour, a correction the
-- owner approved on 2026-09-09. Merging this moves no hours.

CREATE TYPE "status_bucket" AS ENUM ('todo', 'in_progress', 'waiting_to_ship', 'done', 'aborted');

CREATE TYPE "status_bucket_provider" AS ENUM ('jira', 'ado', 'github');

CREATE TABLE "source_status_buckets" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider" "status_bucket_provider" NOT NULL,
    -- Names a row in one of THREE tables — jira_project_syncs,
    -- azure_dev_ops_project_syncs or git_hub_repo_syncs — discriminated by
    -- `provider`, so there is deliberately no foreign key. A deleted sync
    -- leaves orphan rows; they are inert, because nothing reads a bucket for a
    -- source that no longer reports statuses.
    "source_id" TEXT NOT NULL,
    -- Verbatim as the tracker reports it. NOT normalised: casing is
    -- load-bearing, because seedBucket's abandonment rule is an exact-key
    -- lookup against DEFAULT_STAGE_MAP, which is keyed in the tracker's casing.
    -- Lower-casing here would file 'Cancelled' as an ordinary status and let a
    -- customer's Jira category overwrite the one fact no category can express.
    "status" TEXT NOT NULL,
    "bucket" "status_bucket" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_status_buckets_pkey" PRIMARY KEY ("id")
);

-- One decision per status per source, WITHIN a tenant. The upsert key.
--
-- organization_id is in the key because source_id has no foreign key to
-- constrain it against a tenant (it names a row in one of three tables). Without
-- it, a row written under the wrong organization would upsert cleanly and then
-- be invisible to the tenant-scoped read — a status the panel shows as unmapped
-- and cannot map. With it, that is a constraint violation.
CREATE UNIQUE INDEX "source_status_buckets_organization_id_provider_source_id_st_key"
    ON "source_status_buckets"("organization_id", "provider", "source_id", "status");

-- Tenant-scoped reads go through this. Carried directly rather than reached via
-- the sync's instance, matching retired_jira_projects and timesheet_status_rules
-- — TENANCY-PROGRAMME §5a exists because reads like these were once unfiltered.
CREATE INDEX "source_status_buckets_organization_id_idx"
    ON "source_status_buckets"("organization_id");

ALTER TABLE "source_status_buckets"
    ADD CONSTRAINT "source_status_buckets_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
