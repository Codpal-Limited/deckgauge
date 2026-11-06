-- Bitbucket Cloud: the fifth code provider (spec
-- docs/superpowers/specs/2026-11-03-bitbucket-cloud-integration-design.md).
--
-- Hand-written: `prisma migrate dev` cannot run here (shadow-DB P3006). Shapes
-- mirror the GitLab trio (gitlab_instances / gitlab_project_syncs /
-- board_gitlab_sources) as they stand AFTER every later hardening migration, so
-- the ownership and tenancy rules are born in place rather than retrofitted:
--
--   * organization_id NOT NULL, ON DELETE CASCADE — the tenant root, as
--     20260813000000_org_tenancy gave every connection table.
--   * created_by_id ON DELETE SET NULL — provenance only; a departing user's
--     connection becomes unclaimed, not destroyed (20260807000000).
--   * owner_user_id ON DELETE RESTRICT — NULL = organization-wide, a user id =
--     personal. SET NULL would turn a personal connection into an
--     organization-wide one when a user row is deleted, publishing that user's
--     credential to the whole organization; CASCADE would silently delete a
--     leaver's sync configuration (20260820000400).
--
-- api_token is stored as a dgc.v1. envelope (packages/db/src/credential-encryption),
-- never plaintext.

-- AlterEnum. Safe inside the migration transaction on Postgres 12+: the new
-- value is not USED in this transaction.
ALTER TYPE "sync_source" ADD VALUE 'BITBUCKET';

-- CreateTable
CREATE TABLE "bitbucket_instances" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workspace" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL,
    "api_token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "owner_user_id" TEXT,

    CONSTRAINT "bitbucket_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bitbucket_repo_syncs" (
    "id" TEXT NOT NULL,
    "bitbucket_instance_id" TEXT NOT NULL,
    "repo_full_name" TEXT NOT NULL,
    "project_key" TEXT,
    "sync_prs" BOOLEAN NOT NULL DEFAULT true,
    "sync_commits" BOOLEAN NOT NULL DEFAULT true,
    "sync_deployments" BOOLEAN NOT NULL DEFAULT true,
    "last_synced_at" TIMESTAMP(3),
    "last_deployment_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bitbucket_repo_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_bitbucket_sources" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "bitbucket_repo_sync_id" TEXT NOT NULL,
    "target_group_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_bitbucket_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bitbucket_instances_organization_id_idx" ON "bitbucket_instances"("organization_id");

-- CreateIndex
-- (organization_id, owner_user_id) is the shape every visibility query uses:
-- the tenant predicate ANDed with "organization-wide OR mine".
CREATE INDEX "bitbucket_instances_organization_id_owner_user_id_idx" ON "bitbucket_instances"("organization_id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "bitbucket_repo_syncs_bitbucket_instance_id_repo_full_name_key" ON "bitbucket_repo_syncs"("bitbucket_instance_id", "repo_full_name");

-- CreateIndex
CREATE INDEX "board_bitbucket_sources_board_id_idx" ON "board_bitbucket_sources"("board_id");

-- CreateIndex
CREATE UNIQUE INDEX "board_bitbucket_sources_board_id_bitbucket_repo_sync_id_key" ON "board_bitbucket_sources"("board_id", "bitbucket_repo_sync_id");

-- AddForeignKey
ALTER TABLE "bitbucket_instances" ADD CONSTRAINT "bitbucket_instances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bitbucket_instances" ADD CONSTRAINT "bitbucket_instances_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bitbucket_instances" ADD CONSTRAINT "bitbucket_instances_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bitbucket_repo_syncs" ADD CONSTRAINT "bitbucket_repo_syncs_bitbucket_instance_id_fkey" FOREIGN KEY ("bitbucket_instance_id") REFERENCES "bitbucket_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_bitbucket_sources" ADD CONSTRAINT "board_bitbucket_sources_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_bitbucket_sources" ADD CONSTRAINT "board_bitbucket_sources_bitbucket_repo_sync_id_fkey" FOREIGN KEY ("bitbucket_repo_sync_id") REFERENCES "bitbucket_repo_syncs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_bitbucket_sources" ADD CONSTRAINT "board_bitbucket_sources_target_group_id_fkey" FOREIGN KEY ("target_group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
