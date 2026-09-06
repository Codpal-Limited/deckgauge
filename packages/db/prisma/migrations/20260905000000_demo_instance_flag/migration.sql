ALTER TABLE "jira_instances" ADD COLUMN "is_demo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "github_instances" ADD COLUMN "is_demo" BOOLEAN NOT NULL DEFAULT false;
