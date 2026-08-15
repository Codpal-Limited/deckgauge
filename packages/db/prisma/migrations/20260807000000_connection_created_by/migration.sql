-- Creator-scoped provider connections (authz hardening, Task 6).
--
-- Adds a nullable `created_by_id` to each provider-connection table so the
-- CONNECTION_OWNER policy (apps/api/src/auth/policy.ts) can evaluate who may
-- edit or delete a connection. NULL means "unclaimed" — every pre-existing
-- row upgrades to unclaimed rather than orphaned, and stays editable by any
-- signed-in user until the first PATCH claims it (see the four
-- *.service.ts create/update methods).
--
-- ON DELETE SET NULL is deliberate: a departing user's connections become
-- unclaimed again, not destroyed.
--
-- Table and column names confirmed against packages/db/prisma/schema.prisma's
-- @@map directives (JiraInstance -> jira_instances, GitHubInstance ->
-- github_instances, AzureDevOpsInstance -> azure_devops_instances,
-- GitLabInstance -> gitlab_instances, User -> users).

ALTER TABLE "jira_instances"         ADD COLUMN "created_by_id" TEXT;
ALTER TABLE "github_instances"       ADD COLUMN "created_by_id" TEXT;
ALTER TABLE "azure_devops_instances" ADD COLUMN "created_by_id" TEXT;
ALTER TABLE "gitlab_instances"       ADD COLUMN "created_by_id" TEXT;

ALTER TABLE "jira_instances" ADD CONSTRAINT "jira_instances_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "github_instances" ADD CONSTRAINT "github_instances_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "azure_devops_instances" ADD CONSTRAINT "azure_devops_instances_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "gitlab_instances" ADD CONSTRAINT "gitlab_instances_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
