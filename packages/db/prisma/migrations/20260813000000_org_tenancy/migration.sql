-- Org tenancy foundation, Phase A. See
-- docs/superpowers/specs/2026-08-05-org-tenancy-foundation-design.md §7.

-- 1. Enums
CREATE TYPE "org_role" AS ENUM ('ADMIN', 'MEMBER', 'VIEWER');
CREATE TYPE "org_membership_status" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');

-- 2. Tables
CREATE TABLE "organizations" (
    "id"         TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "slug"       TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

CREATE TABLE "org_memberships" (
    "id"                  TEXT NOT NULL,
    "organization_id"     TEXT NOT NULL,
    "email"               TEXT NOT NULL,
    "user_id"             TEXT,
    "role"                "org_role" NOT NULL,
    "status"              "org_membership_status" NOT NULL DEFAULT 'PENDING',
    "invited_by_user_id"  TEXT,
    "invited_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at"        TIMESTAMP(3),
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "org_memberships_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "org_memberships_organization_id_email_key"
    ON "org_memberships"("organization_id", "email");
CREATE UNIQUE INDEX "org_memberships_organization_id_user_id_key"
    ON "org_memberships"("organization_id", "user_id");
CREATE INDEX "org_memberships_organization_id_status_idx"
    ON "org_memberships"("organization_id", "status");
CREATE INDEX "org_memberships_user_id_idx" ON "org_memberships"("user_id");

ALTER TABLE "org_memberships"
    ADD CONSTRAINT "org_memberships_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "org_memberships"
    ADD CONSTRAINT "org_memberships_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "org_memberships"
    ADD CONSTRAINT "org_memberships_invited_by_user_id_fkey"
    FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 3 + 4. Seed the organization, then tenant the roots: add nullable, backfill,
--        enforce, index.
--
-- The organization is seeded ONLY IF this database already holds data for it to
-- own. A fresh install must end with ZERO organizations, so that the first
-- Keycloak login goes through the bootstrap flow (spec §5.2) and creates org #1.
-- Seeding unconditionally would leave a first-time setup with 1 organization and
-- 0 memberships, which is unenterable: the auth gate answers 403 NO_ORGANIZATION
-- and bootstrap answers 409 against the one-org cap, with no in-app recovery.
--
-- "Already holds data" is NOT the same as "has users". Rows can exist in a tenant
-- root while "users" is empty, so testing only "users" would leave those rows
-- pointing at an organization that was never inserted, and the FK below would
-- abort the migration. Two confirmed paths:
--   * apps/worker bootstrapAdoFromYaml() creates azure_devops_instances at worker
--     startup from config/azure-devops.yaml, with no user involved at all.
--   * apps/api's Keycloak plugin currently returns early when the request carries
--     no Authorization header ("V1: single-user, no auth required"), so any
--     settings route can create a root row with no User row present. Task 7
--     closes that; databases created before it did not.
-- Hence the check below spans "users" AND all twelve roots.
--
-- Name and slug are fixed on purpose: a migration must not read env. The admin
-- renames it in General settings (spec §7 step 3).
--
-- "AdvisorConfig" is deliberately excluded from the plain single-column index: it
-- carries a UNIQUE index on organization_id instead (one config per org), created
-- in the block that follows. A plain index there would be redundant and would
-- show up as schema drift.
DO $$
DECLARE
    t TEXT;
    org_id TEXT := '00000000-0000-4000-8000-000000000001';
    tables TEXT[] := ARRAY[
        'boards', 'roadmaps', 'org_trees', 'comparisons', 'board_folders',
        'jira_instances', 'github_instances', 'azure_devops_instances',
        'gitlab_instances', 'AdvisorConfig', 'timesheet_status_rules',
        'retired_jira_projects'
    ];
    has_data BOOLEAN;
    table_has_rows BOOLEAN;
BEGIN
    SELECT EXISTS (SELECT 1 FROM "users") INTO has_data;

    IF NOT has_data THEN
        FOREACH t IN ARRAY tables LOOP
            EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', t) INTO table_has_rows;
            IF table_has_rows THEN
                has_data := TRUE;
                EXIT;
            END IF;
        END LOOP;
    END IF;

    IF has_data THEN
        INSERT INTO "organizations" ("id", "name", "slug", "created_at", "updated_at")
        VALUES (org_id, 'Deckgauge', 'deckgauge', NOW(), NOW());
    END IF;

    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('ALTER TABLE %I ADD COLUMN "organization_id" TEXT', t);
        -- When has_data is false every root is provably empty, so this UPDATE
        -- matches zero rows and SET NOT NULL below still succeeds. Guarded anyway
        -- so no row can ever reference an organization that was not inserted.
        IF has_data THEN
            EXECUTE format('UPDATE %I SET "organization_id" = %L', t, org_id);
        END IF;
        EXECUTE format('ALTER TABLE %I ALTER COLUMN "organization_id" SET NOT NULL', t);
        EXECUTE format(
            'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("organization_id") '
            'REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE',
            t, t || '_organization_id_fkey');
        IF t <> 'AdvisorConfig' THEN
            EXECUTE format('CREATE INDEX %I ON %I ("organization_id")',
                t || '_organization_id_idx', t);
        END IF;
    END LOOP;
END $$;

-- "boards"."createdAt" and "boards"."updatedAt" have no @map in the Prisma
-- schema, so their Postgres columns are quoted mixed-case. Do not snake_case.
CREATE INDEX "boards_organization_id_created_at_idx"
    ON "boards"("organization_id", "createdAt");
CREATE INDEX "org_trees_organization_id_position_idx"
    ON "org_trees"("organization_id", "position");
CREATE UNIQUE INDEX "AdvisorConfig_organization_id_key"
    ON "AdvisorConfig"("organization_id");

-- 5. Constraints that must now include the tenant.
--    Names verified in Step 1 of this task. Prisma implements @@unique as a bare
--    UNIQUE INDEX, not a table constraint, so this is DROP INDEX; the
--    retired_jira_projects primary key really is a constraint.
DROP INDEX "timesheet_status_rules_scope_role_employee_id_key";
CREATE UNIQUE INDEX "timesheet_status_rules_org_scope_role_employee_key"
    ON "timesheet_status_rules"("organization_id", "scope", "role", "employee_id");

ALTER TABLE "retired_jira_projects" DROP CONSTRAINT "retired_jira_projects_pkey";
ALTER TABLE "retired_jira_projects"
    ADD CONSTRAINT "retired_jira_projects_pkey"
    PRIMARY KEY ("organization_id", "project_key");

-- 6. Existing users become members. The earliest by created_at becomes ADMIN so
--    the deployment is not left without one; the rest become MEMBER. This is a
--    deliberate privilege grant — the alternative locks every existing user out
--    of a database holding real data, with no admin left to readmit them
--    (spec §7 step 6).
--
--    Safe by construction against the conditional seed above: if "users" has any
--    row then has_data was true and the organization exists. If "users" is empty
--    this INSERT ... SELECT matches nothing, so it cannot reference a missing org.
INSERT INTO "org_memberships" (
    "id", "organization_id", "email", "user_id", "role", "status",
    "invited_at", "activated_at", "created_at", "updated_at"
)
SELECT
    gen_random_uuid()::TEXT,
    '00000000-0000-4000-8000-000000000001',
    LOWER(u."email"),
    u."id",
    CASE WHEN u."id" = (SELECT "id" FROM "users" ORDER BY "created_at" ASC, "id" ASC LIMIT 1)
         THEN 'ADMIN'::"org_role" ELSE 'MEMBER'::"org_role" END,
    'ACTIVE'::"org_membership_status",
    NOW(), NOW(), NOW(), NOW()
FROM "users" u;
