-- CreateEnum
CREATE TYPE "project_status" AS ENUM ('Not started', 'In progress', 'At risk', 'Blocked', 'Done');

-- CreateEnum
CREATE TYPE "cost_classification" AS ENUM ('CAPEX', 'OPEX');

-- CreateEnum
CREATE TYPE "sync_run_status" AS ENUM ('pending', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "sync_run_trigger" AS ENUM ('startup', 'manual', 'scheduled');

-- CreateEnum
CREATE TYPE "column_type" AS ENUM ('text', 'status', 'date', 'number', 'checkbox', 'dropdown', 'person', 'link');

-- CreateEnum
CREATE TYPE "azure_devops_auth_method" AS ENUM ('pat', 'basic');

-- CreateEnum
CREATE TYPE "sync_source" AS ENUM ('ADO', 'GITHUB', 'JIRA', 'GITLAB');

-- CreateEnum
CREATE TYPE "timesheet_rule_scope" AS ENUM ('ROLE', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "board_access_role" AS ENUM ('OWNER', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "board_view_type" AS ENUM ('board', 'dashboard', 'roadmap', 'comparison');

-- CreateEnum
CREATE TYPE "roadmap_access_role" AS ENUM ('owner', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "roadmap_group_source" AS ENUM ('manual', 'board_sub');

-- CreateEnum
CREATE TYPE "roadmap_view_type" AS ENUM ('grid', 'gantt');

-- CreateTable
CREATE TABLE "boards" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'development',
    "ticket_key_prefixes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hidden_system_fields" TEXT[] DEFAULT ARRAY['startDate', 'endDate', 'duration']::TEXT[],
    "column_layout" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_calendar_events" (
    "id" TEXT NOT NULL,
    "board_id" TEXT,
    "label" VARCHAR(120) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "color" VARCHAR(20),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_owners" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "color" VARCHAR(7) NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "user_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_statuses" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "label" VARCHAR(50) NOT NULL,
    "color" VARCHAR(7) NOT NULL,
    "icon" VARCHAR(10),
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_sync_exclusions" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "source" "sync_source" NOT NULL,
    "external_id" TEXT NOT NULL,
    "excluded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "excluded_by" TEXT,

    CONSTRAINT "board_sync_exclusions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT NOT NULL DEFAULT '#6C6CFF',
    "board_id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "assignee" TEXT NOT NULL DEFAULT '',
    "owner_overridden" BOOLEAN NOT NULL DEFAULT false,
    "status" "project_status" NOT NULL,
    "description" TEXT,
    "board_id" TEXT,
    "group_id" TEXT,
    "owner_id" TEXT,
    "status_id" TEXT,
    "order" DOUBLE PRECISION,
    "jira_key" TEXT,
    "jira_project_key" TEXT,
    "jira_type" TEXT,
    "jira_synced_fields" JSONB,
    "jira_removed_from_source" BOOLEAN NOT NULL DEFAULT false,
    "github_issue_id" TEXT,
    "github_repo_full_name" TEXT,
    "github_synced_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "github_removed_from_source" BOOLEAN NOT NULL DEFAULT false,
    "ado_work_item_id" INTEGER,
    "ado_project" TEXT,
    "ado_synced_fields" JSONB,
    "ado_removed_from_source" BOOLEAN NOT NULL DEFAULT false,
    "roadmap_pinned_start" TIMESTAMP(3),
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "due_date" TIMESTAMP(3),
    "duration_code" TEXT,
    "cost_classification" "cost_classification",
    "onboarded_employee_id" TEXT,
    "calendar_event_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_comments" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "author_name" TEXT NOT NULL DEFAULT 'VP',
    "author_avatar" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "author_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_columns" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "column_type" NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB,

    CONSTRAINT "board_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_field_values" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "columnId" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "project_field_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" JSONB NOT NULL,
    "action" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jira_instances" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "atlassianUrl" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "apiToken" TEXT NOT NULL,
    "projectKeys" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jira_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" TEXT NOT NULL,
    "status" "sync_run_status" NOT NULL,
    "trigger" "sync_run_trigger" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "epicCount" INTEGER NOT NULL DEFAULT 0,
    "issueCount" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT,
    "work_item_count" INTEGER NOT NULL DEFAULT 0,
    "jira_project_sync_id" TEXT,
    "github_repo_sync_id" TEXT,
    "azure_devops_project_sync_id" TEXT,
    "gitlab_project_sync_id" TEXT,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uploads" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "comment_id" TEXT,
    "project_id" TEXT,
    "org_employee_id" TEXT,
    "employee_comment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_instances" (
    "id" TEXT NOT NULL,
    "base_url" TEXT NOT NULL DEFAULT 'https://api.github.com',
    "access_token" TEXT NOT NULL,
    "org" TEXT NOT NULL DEFAULT '',
    "repos" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "azure_devops_instances" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "org_url" TEXT NOT NULL,
    "auth_method" "azure_devops_auth_method" NOT NULL,
    "access_token" TEXT NOT NULL,
    "username" TEXT,
    "projects" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "azure_devops_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "keycloak_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "developer_profiles" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "login" VARCHAR(256) NOT NULL,
    "display_name" VARCHAR(256),
    "avatar_url" TEXT,
    "email" VARCHAR(320),
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "developer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_access" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "board_access_role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_views" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "type" "board_view_type" NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "preset_key" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comparisons" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comparisons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comparison_members" (
    "id" TEXT NOT NULL,
    "comparison_id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comparison_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roadmap_configs" (
    "id" TEXT NOT NULL,
    "board_view_id" TEXT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "visible_quarters" INTEGER NOT NULL DEFAULT 4,
    "size_durations" JSONB NOT NULL,
    "default_size_weeks" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "hidden_group_ids" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roadmap_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_widgets" (
    "id" TEXT NOT NULL,
    "board_view_id" TEXT NOT NULL,
    "widget_type" VARCHAR(50) NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "layout" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_widgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_status_changes" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_by" TEXT,

    CONSTRAINT "project_status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gitlab_instances" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL DEFAULT 'https://gitlab.com/api/v4',
    "access_token" TEXT NOT NULL,
    "projects" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gitlab_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jira_project_syncs" (
    "id" TEXT NOT NULL,
    "jira_instance_id" TEXT NOT NULL,
    "jira_project_key" TEXT NOT NULL,
    "sync_changelog" BOOLEAN NOT NULL DEFAULT true,
    "sync_worklogs" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jira_project_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_jira_sources" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "jira_project_sync_id" TEXT NOT NULL,
    "target_group_id" TEXT,
    "allowed_issue_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "jql_filter" TEXT,
    "field_mappings" JSONB NOT NULL DEFAULT '{}',
    "default_synced_fields" JSONB NOT NULL DEFAULT '["name","status","owner"]',
    "status_mapping" JSONB NOT NULL DEFAULT '{}',
    "last_promoted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_jira_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_repo_syncs" (
    "id" TEXT NOT NULL,
    "github_instance_id" TEXT NOT NULL,
    "repo_full_name" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "language" TEXT,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_pushed_at" TIMESTAMP(3),
    "open_issues_count" INTEGER NOT NULL DEFAULT 0,
    "tier" TEXT NOT NULL DEFAULT 'warm',
    "prs_watermark" TIMESTAMP(3),
    "commits_watermark" TIMESTAMP(3),
    "reviews_watermark" TIMESTAMP(3),
    "workflow_runs_watermark" TIMESTAMP(3),
    "deployments_watermark" TIMESTAMP(3),
    "issues_watermark" TIMESTAMP(3),
    "backfill_months" INTEGER NOT NULL DEFAULT 12,
    "backfill_complete_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "last_error_at" TIMESTAMP(3),
    "last_error_message" TEXT,
    "disabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_repo_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_jira_links" (
    "id" TEXT NOT NULL,
    "pr_id" TEXT NOT NULL,
    "repo_full_name" TEXT NOT NULL,
    "jira_key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "merged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_jira_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_github_sources" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "github_repo_sync_id" TEXT NOT NULL,
    "target_group_id" TEXT,
    "sync_issues_to_board" BOOLEAN NOT NULL DEFAULT true,
    "use_for_intelligence" BOOLEAN NOT NULL DEFAULT true,
    "allowed_labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "include_closed_issues" BOOLEAN NOT NULL DEFAULT false,
    "status_mapping" JSONB NOT NULL DEFAULT '{}',
    "default_synced_fields" TEXT[] DEFAULT ARRAY['name', 'description', 'status', 'owner']::TEXT[],
    "last_promoted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_github_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "azure_devops_project_syncs" (
    "id" TEXT NOT NULL,
    "azure_devops_instance_id" TEXT NOT NULL,
    "ado_project" TEXT NOT NULL,
    "sync_prs" BOOLEAN NOT NULL DEFAULT false,
    "sync_commits" BOOLEAN NOT NULL DEFAULT false,
    "sync_repos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sync_all_repos" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "azure_devops_project_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ado_repo_sync_states" (
    "id" TEXT NOT NULL,
    "azure_devops_project_sync_id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "repo_name" TEXT NOT NULL,
    "last_pr_sync_at" TIMESTAMP(3),
    "last_commit_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ado_repo_sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_ado_sources" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "azure_devops_project_sync_id" TEXT NOT NULL,
    "target_group_id" TEXT,
    "sync_work_items_to_board" BOOLEAN NOT NULL DEFAULT true,
    "use_for_intelligence" BOOLEAN NOT NULL DEFAULT true,
    "allowed_work_item_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "wiql_filter" TEXT,
    "field_mappings" JSONB NOT NULL DEFAULT '{}',
    "status_mapping" JSONB NOT NULL DEFAULT '{}',
    "default_synced_fields" TEXT[] DEFAULT ARRAY['name', 'status', 'owner']::TEXT[],
    "last_promoted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_ado_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gitlab_project_syncs" (
    "id" TEXT NOT NULL,
    "gitlab_instance_id" TEXT NOT NULL,
    "project_path" TEXT NOT NULL,
    "sync_prs" BOOLEAN NOT NULL DEFAULT true,
    "sync_commits" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gitlab_project_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_gitlab_sources" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "gitlab_project_sync_id" TEXT NOT NULL,
    "target_group_id" TEXT,
    "sync_issues_to_board" BOOLEAN NOT NULL DEFAULT false,
    "sync_mrs_to_board" BOOLEAN NOT NULL DEFAULT false,
    "last_promoted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_gitlab_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_folders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6366F1',
    "position" DOUBLE PRECISION NOT NULL,
    "is_expanded" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_board_prefs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "folder_id" TEXT,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "is_favorite" BOOLEAN NOT NULL DEFAULT false,
    "is_hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_board_prefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_trees" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "last_synced_at" TIMESTAMP(3),
    "last_sync_summary" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_trees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_employees" (
    "id" TEXT NOT NULL,
    "org_tree_id" TEXT NOT NULL,
    "external_id" TEXT,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "email" TEXT,
    "manager_external_id" TEXT,
    "manager_id" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_vacancy" BOOLEAN NOT NULL DEFAULT false,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "last_contribution_at" TIMESTAMP(3),
    "has_assignment" BOOLEAN NOT NULL DEFAULT false,
    "employee_display_id" TEXT,
    "business_title" TEXT,
    "hire_date" TIMESTAMP(3),
    "location" TEXT,
    "employee_type" TEXT,
    "time_type" TEXT,
    "phone" TEXT,
    "work_address" TEXT,
    "salary_current" INTEGER,
    "salary_currency" TEXT,
    "stats_json" JSONB,
    "synced_at" TIMESTAMP(3),
    "ms_graph_id" TEXT,
    "departed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_tree_sources" (
    "id" TEXT NOT NULL,
    "org_tree_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'microsoft',
    "root_upn" TEXT NOT NULL,
    "root_graph_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "last_synced_at" TIMESTAMP(3),
    "last_sync_summary" JSONB,
    "ms_access_token" TEXT,
    "ms_refresh_token" TEXT,
    "microsoft_upn" TEXT,
    "connected_by_email" TEXT,
    "connected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_tree_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "board_calendar_sources" (
    "id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'microsoft',
    "calendar_upn" TEXT NOT NULL DEFAULT '',
    "ms_access_token" TEXT,
    "ms_refresh_token" TEXT,
    "microsoft_upn" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "last_synced_at" TIMESTAMP(3),
    "last_sync_summary" JSONB,
    "connected_by_email" TEXT,
    "connected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_calendar_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_employee_aliases" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_employee_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_employee_comments" (
    "id" TEXT NOT NULL,
    "org_employee_id" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "author_name" TEXT NOT NULL DEFAULT 'VP',
    "author_avatar" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "author_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_employee_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_boards" (
    "id" TEXT NOT NULL,
    "org_tree_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope_employee_id" TEXT,
    "column_config" JSONB,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_groups" (
    "id" TEXT NOT NULL,
    "employee_board_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6366F1',
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_board_members" (
    "id" TEXT NOT NULL,
    "employee_board_id" TEXT NOT NULL,
    "org_employee_id" TEXT NOT NULL,
    "employee_group_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_board_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_columns" (
    "id" TEXT NOT NULL,
    "employee_board_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_field_values" (
    "id" TEXT NOT NULL,
    "employee_column_id" TEXT NOT NULL,
    "org_employee_id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_field_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roadmaps" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_by" TEXT NOT NULL,
    "hidden_system_columns" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roadmaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roadmap_access" (
    "id" TEXT NOT NULL,
    "roadmap_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "roadmap_access_role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roadmap_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roadmap_board_subscriptions" (
    "id" TEXT NOT NULL,
    "roadmap_id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roadmap_board_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roadmap_groups" (
    "id" TEXT NOT NULL,
    "roadmap_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "source" "roadmap_group_source" NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roadmap_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roadmap_views" (
    "id" TEXT NOT NULL,
    "roadmap_id" TEXT NOT NULL,
    "type" "roadmap_view_type" NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roadmap_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roadmap_gantt_configs" (
    "id" TEXT NOT NULL,
    "roadmap_view_id" TEXT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "visible_quarters" INTEGER NOT NULL DEFAULT 4,
    "size_durations" JSONB NOT NULL,
    "default_size_weeks" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "hidden_group_ids" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roadmap_gantt_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roadmap_prefs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "roadmap_id" TEXT NOT NULL,
    "folder_id" TEXT,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "is_favorite" BOOLEAN NOT NULL DEFAULT false,
    "is_hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_roadmap_prefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheet_status_rules" (
    "id" TEXT NOT NULL,
    "scope" "timesheet_rule_scope" NOT NULL,
    "role" TEXT,
    "employee_id" TEXT,
    "in_progress_statuses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timesheet_status_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_tree_timesheet_configs" (
    "org_tree_id" TEXT NOT NULL,
    "active_statuses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "daily_cap_hours" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_tree_timesheet_configs_pkey" PRIMARY KEY ("org_tree_id")
);

-- CreateTable
CREATE TABLE "retired_jira_projects" (
    "project_key" TEXT NOT NULL,
    "cutoff_date" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retired_jira_projects_pkey" PRIMARY KEY ("project_key")
);

-- CreateIndex
CREATE INDEX "board_calendar_events_board_id_idx" ON "board_calendar_events"("board_id");

-- CreateIndex
CREATE INDEX "board_owners_board_id_idx" ON "board_owners"("board_id");

-- CreateIndex
CREATE INDEX "board_owners_user_id_idx" ON "board_owners"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "board_owners_board_id_name_key" ON "board_owners"("board_id", "name");

-- CreateIndex
CREATE INDEX "board_statuses_board_id_idx" ON "board_statuses"("board_id");

-- CreateIndex
CREATE UNIQUE INDEX "board_statuses_board_id_label_key" ON "board_statuses"("board_id", "label");

-- CreateIndex
CREATE INDEX "board_sync_exclusions_board_id_source_idx" ON "board_sync_exclusions"("board_id", "source");

-- CreateIndex
CREATE UNIQUE INDEX "board_sync_exclusions_board_id_source_external_id_key" ON "board_sync_exclusions"("board_id", "source", "external_id");

-- CreateIndex
CREATE INDEX "groups_board_id_position_idx" ON "groups"("board_id", "position");

-- CreateIndex
CREATE INDEX "projects_board_id_status_idx" ON "projects"("board_id", "status");

-- CreateIndex
CREATE INDEX "projects_board_id_updatedAt_idx" ON "projects"("board_id", "updatedAt");

-- CreateIndex
CREATE INDEX "projects_board_id_owner_id_idx" ON "projects"("board_id", "owner_id");

-- CreateIndex
CREATE INDEX "projects_group_id_order_idx" ON "projects"("group_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "projects_board_id_jira_key_jira_project_key_key" ON "projects"("board_id", "jira_key", "jira_project_key");

-- CreateIndex
CREATE UNIQUE INDEX "projects_board_id_ado_work_item_id_key" ON "projects"("board_id", "ado_work_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_board_id_github_issue_id_key" ON "projects"("board_id", "github_issue_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_board_id_calendar_event_id_key" ON "projects"("board_id", "calendar_event_id");

-- CreateIndex
CREATE INDEX "project_comments_project_id_pinned_created_at_idx" ON "project_comments"("project_id", "pinned", "created_at");

-- CreateIndex
CREATE INDEX "project_comments_author_id_idx" ON "project_comments"("author_id");

-- CreateIndex
CREATE INDEX "board_columns_boardId_order_idx" ON "board_columns"("boardId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "project_field_values_projectId_columnId_key" ON "project_field_values"("projectId", "columnId");

-- CreateIndex
CREATE INDEX "sync_runs_startedAt_idx" ON "sync_runs"("startedAt");

-- CreateIndex
CREATE INDEX "sync_runs_status_idx" ON "sync_runs"("status");

-- CreateIndex
CREATE INDEX "uploads_project_id_idx" ON "uploads"("project_id");

-- CreateIndex
CREATE INDEX "uploads_comment_id_idx" ON "uploads"("comment_id");

-- CreateIndex
CREATE INDEX "uploads_org_employee_id_idx" ON "uploads"("org_employee_id");

-- CreateIndex
CREATE INDEX "uploads_employee_comment_id_idx" ON "uploads"("employee_comment_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_keycloak_id_key" ON "users"("keycloak_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "developer_profiles_user_id_idx" ON "developer_profiles"("user_id");

-- CreateIndex
CREATE INDEX "developer_profiles_email_idx" ON "developer_profiles"("email");

-- CreateIndex
CREATE UNIQUE INDEX "developer_profiles_provider_login_key" ON "developer_profiles"("provider", "login");

-- CreateIndex
CREATE INDEX "board_access_board_id_idx" ON "board_access"("board_id");

-- CreateIndex
CREATE INDEX "board_access_user_id_idx" ON "board_access"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "board_access_board_id_user_id_key" ON "board_access"("board_id", "user_id");

-- CreateIndex
CREATE INDEX "board_views_board_id_idx" ON "board_views"("board_id");

-- CreateIndex
CREATE INDEX "board_views_preset_key_idx" ON "board_views"("preset_key");

-- CreateIndex
CREATE INDEX "comparisons_created_by_idx" ON "comparisons"("created_by");

-- CreateIndex
CREATE INDEX "comparison_members_comparison_id_position_idx" ON "comparison_members"("comparison_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "comparison_members_comparison_id_board_id_key" ON "comparison_members"("comparison_id", "board_id");

-- CreateIndex
CREATE UNIQUE INDEX "roadmap_configs_board_view_id_key" ON "roadmap_configs"("board_view_id");

-- CreateIndex
CREATE INDEX "dashboard_widgets_board_view_id_idx" ON "dashboard_widgets"("board_view_id");

-- CreateIndex
CREATE INDEX "project_status_changes_project_id_changed_at_idx" ON "project_status_changes"("project_id", "changed_at");

-- CreateIndex
CREATE INDEX "project_status_changes_to_status_changed_at_idx" ON "project_status_changes"("to_status", "changed_at");

-- CreateIndex
CREATE UNIQUE INDEX "jira_project_syncs_jira_instance_id_jira_project_key_key" ON "jira_project_syncs"("jira_instance_id", "jira_project_key");

-- CreateIndex
CREATE INDEX "board_jira_sources_board_id_idx" ON "board_jira_sources"("board_id");

-- CreateIndex
CREATE INDEX "board_jira_sources_jira_project_sync_id_idx" ON "board_jira_sources"("jira_project_sync_id");

-- CreateIndex
CREATE UNIQUE INDEX "board_jira_sources_board_id_jira_project_sync_id_key" ON "board_jira_sources"("board_id", "jira_project_sync_id");

-- CreateIndex
CREATE INDEX "github_repo_syncs_tier_last_success_at_idx" ON "github_repo_syncs"("tier", "last_success_at");

-- CreateIndex
CREATE INDEX "github_repo_syncs_disabled_at_idx" ON "github_repo_syncs"("disabled_at");

-- CreateIndex
CREATE UNIQUE INDEX "github_repo_syncs_github_instance_id_repo_full_name_key" ON "github_repo_syncs"("github_instance_id", "repo_full_name");

-- CreateIndex
CREATE INDEX "pr_jira_links_jira_key_idx" ON "pr_jira_links"("jira_key");

-- CreateIndex
CREATE INDEX "pr_jira_links_repo_full_name_idx" ON "pr_jira_links"("repo_full_name");

-- CreateIndex
CREATE UNIQUE INDEX "pr_jira_links_pr_id_jira_key_source_key" ON "pr_jira_links"("pr_id", "jira_key", "source");

-- CreateIndex
CREATE INDEX "board_github_sources_board_id_idx" ON "board_github_sources"("board_id");

-- CreateIndex
CREATE UNIQUE INDEX "board_github_sources_board_id_github_repo_sync_id_key" ON "board_github_sources"("board_id", "github_repo_sync_id");

-- CreateIndex
CREATE UNIQUE INDEX "azure_devops_project_syncs_azure_devops_instance_id_ado_pro_key" ON "azure_devops_project_syncs"("azure_devops_instance_id", "ado_project");

-- CreateIndex
CREATE INDEX "ado_repo_sync_states_azure_devops_project_sync_id_idx" ON "ado_repo_sync_states"("azure_devops_project_sync_id");

-- CreateIndex
CREATE UNIQUE INDEX "ado_repo_sync_states_azure_devops_project_sync_id_repo_id_key" ON "ado_repo_sync_states"("azure_devops_project_sync_id", "repo_id");

-- CreateIndex
CREATE INDEX "board_ado_sources_board_id_idx" ON "board_ado_sources"("board_id");

-- CreateIndex
CREATE UNIQUE INDEX "board_ado_sources_board_id_azure_devops_project_sync_id_key" ON "board_ado_sources"("board_id", "azure_devops_project_sync_id");

-- CreateIndex
CREATE UNIQUE INDEX "gitlab_project_syncs_gitlab_instance_id_project_path_key" ON "gitlab_project_syncs"("gitlab_instance_id", "project_path");

-- CreateIndex
CREATE INDEX "board_gitlab_sources_board_id_idx" ON "board_gitlab_sources"("board_id");

-- CreateIndex
CREATE UNIQUE INDEX "board_gitlab_sources_board_id_gitlab_project_sync_id_key" ON "board_gitlab_sources"("board_id", "gitlab_project_sync_id");

-- CreateIndex
CREATE INDEX "board_folders_user_id_parent_id_position_idx" ON "board_folders"("user_id", "parent_id", "position");

-- CreateIndex
CREATE INDEX "user_board_prefs_user_id_folder_id_position_idx" ON "user_board_prefs"("user_id", "folder_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "user_board_prefs_user_id_board_id_key" ON "user_board_prefs"("user_id", "board_id");

-- CreateIndex
CREATE INDEX "org_employees_org_tree_id_idx" ON "org_employees"("org_tree_id");

-- CreateIndex
CREATE INDEX "org_employees_manager_id_idx" ON "org_employees"("manager_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_employees_org_tree_id_external_id_key" ON "org_employees"("org_tree_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_employees_org_tree_id_ms_graph_id_key" ON "org_employees"("org_tree_id", "ms_graph_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_tree_sources_org_tree_id_key" ON "org_tree_sources"("org_tree_id");

-- CreateIndex
CREATE UNIQUE INDEX "board_calendar_sources_board_id_key" ON "board_calendar_sources"("board_id");

-- CreateIndex
CREATE INDEX "org_employee_aliases_employee_id_idx" ON "org_employee_aliases"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_employee_aliases_employee_id_provider_kind_value_key" ON "org_employee_aliases"("employee_id", "provider", "kind", "value");

-- CreateIndex
CREATE INDEX "org_employee_comments_org_employee_id_pinned_created_at_idx" ON "org_employee_comments"("org_employee_id", "pinned", "created_at");

-- CreateIndex
CREATE INDEX "org_employee_comments_author_id_idx" ON "org_employee_comments"("author_id");

-- CreateIndex
CREATE INDEX "employee_boards_org_tree_id_idx" ON "employee_boards"("org_tree_id");

-- CreateIndex
CREATE INDEX "employee_groups_employee_board_id_idx" ON "employee_groups"("employee_board_id");

-- CreateIndex
CREATE INDEX "employee_board_members_employee_group_id_position_idx" ON "employee_board_members"("employee_group_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "employee_board_members_employee_board_id_org_employee_id_key" ON "employee_board_members"("employee_board_id", "org_employee_id");

-- CreateIndex
CREATE INDEX "employee_columns_employee_board_id_idx" ON "employee_columns"("employee_board_id");

-- CreateIndex
CREATE INDEX "employee_field_values_org_employee_id_idx" ON "employee_field_values"("org_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_field_values_employee_column_id_org_employee_id_key" ON "employee_field_values"("employee_column_id", "org_employee_id");

-- CreateIndex
CREATE INDEX "roadmap_access_roadmap_id_idx" ON "roadmap_access"("roadmap_id");

-- CreateIndex
CREATE INDEX "roadmap_access_user_id_idx" ON "roadmap_access"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "roadmap_access_roadmap_id_user_id_key" ON "roadmap_access"("roadmap_id", "user_id");

-- CreateIndex
CREATE INDEX "roadmap_board_subscriptions_roadmap_id_idx" ON "roadmap_board_subscriptions"("roadmap_id");

-- CreateIndex
CREATE UNIQUE INDEX "roadmap_board_subscriptions_roadmap_id_board_id_key" ON "roadmap_board_subscriptions"("roadmap_id", "board_id");

-- CreateIndex
CREATE INDEX "roadmap_groups_roadmap_id_position_idx" ON "roadmap_groups"("roadmap_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "roadmap_groups_roadmap_id_group_id_key" ON "roadmap_groups"("roadmap_id", "group_id");

-- CreateIndex
CREATE INDEX "roadmap_views_roadmap_id_idx" ON "roadmap_views"("roadmap_id");

-- CreateIndex
CREATE UNIQUE INDEX "roadmap_gantt_configs_roadmap_view_id_key" ON "roadmap_gantt_configs"("roadmap_view_id");

-- CreateIndex
CREATE INDEX "user_roadmap_prefs_user_id_folder_id_position_idx" ON "user_roadmap_prefs"("user_id", "folder_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "user_roadmap_prefs_user_id_roadmap_id_key" ON "user_roadmap_prefs"("user_id", "roadmap_id");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_status_rules_scope_role_employee_id_key" ON "timesheet_status_rules"("scope", "role", "employee_id");

-- AddForeignKey
ALTER TABLE "board_calendar_events" ADD CONSTRAINT "board_calendar_events_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_owners" ADD CONSTRAINT "board_owners_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_owners" ADD CONSTRAINT "board_owners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_statuses" ADD CONSTRAINT "board_statuses_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_sync_exclusions" ADD CONSTRAINT "board_sync_exclusions_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "board_owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "board_statuses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_comments" ADD CONSTRAINT "project_comments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_comments" ADD CONSTRAINT "project_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_field_values" ADD CONSTRAINT "project_field_values_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_field_values" ADD CONSTRAINT "project_field_values_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "board_columns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "project_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_org_employee_id_fkey" FOREIGN KEY ("org_employee_id") REFERENCES "org_employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_employee_comment_id_fkey" FOREIGN KEY ("employee_comment_id") REFERENCES "org_employee_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "developer_profiles" ADD CONSTRAINT "developer_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_access" ADD CONSTRAINT "board_access_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_access" ADD CONSTRAINT "board_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_views" ADD CONSTRAINT "board_views_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_members" ADD CONSTRAINT "comparison_members_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "comparisons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparison_members" ADD CONSTRAINT "comparison_members_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roadmap_configs" ADD CONSTRAINT "roadmap_configs_board_view_id_fkey" FOREIGN KEY ("board_view_id") REFERENCES "board_views"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_board_view_id_fkey" FOREIGN KEY ("board_view_id") REFERENCES "board_views"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_status_changes" ADD CONSTRAINT "project_status_changes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jira_project_syncs" ADD CONSTRAINT "jira_project_syncs_jira_instance_id_fkey" FOREIGN KEY ("jira_instance_id") REFERENCES "jira_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_jira_sources" ADD CONSTRAINT "board_jira_sources_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_jira_sources" ADD CONSTRAINT "board_jira_sources_jira_project_sync_id_fkey" FOREIGN KEY ("jira_project_sync_id") REFERENCES "jira_project_syncs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_jira_sources" ADD CONSTRAINT "board_jira_sources_target_group_id_fkey" FOREIGN KEY ("target_group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_repo_syncs" ADD CONSTRAINT "github_repo_syncs_github_instance_id_fkey" FOREIGN KEY ("github_instance_id") REFERENCES "github_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_github_sources" ADD CONSTRAINT "board_github_sources_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_github_sources" ADD CONSTRAINT "board_github_sources_github_repo_sync_id_fkey" FOREIGN KEY ("github_repo_sync_id") REFERENCES "github_repo_syncs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_github_sources" ADD CONSTRAINT "board_github_sources_target_group_id_fkey" FOREIGN KEY ("target_group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "azure_devops_project_syncs" ADD CONSTRAINT "azure_devops_project_syncs_azure_devops_instance_id_fkey" FOREIGN KEY ("azure_devops_instance_id") REFERENCES "azure_devops_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ado_repo_sync_states" ADD CONSTRAINT "ado_repo_sync_states_azure_devops_project_sync_id_fkey" FOREIGN KEY ("azure_devops_project_sync_id") REFERENCES "azure_devops_project_syncs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_ado_sources" ADD CONSTRAINT "board_ado_sources_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_ado_sources" ADD CONSTRAINT "board_ado_sources_azure_devops_project_sync_id_fkey" FOREIGN KEY ("azure_devops_project_sync_id") REFERENCES "azure_devops_project_syncs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_ado_sources" ADD CONSTRAINT "board_ado_sources_target_group_id_fkey" FOREIGN KEY ("target_group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gitlab_project_syncs" ADD CONSTRAINT "gitlab_project_syncs_gitlab_instance_id_fkey" FOREIGN KEY ("gitlab_instance_id") REFERENCES "gitlab_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_gitlab_sources" ADD CONSTRAINT "board_gitlab_sources_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_gitlab_sources" ADD CONSTRAINT "board_gitlab_sources_gitlab_project_sync_id_fkey" FOREIGN KEY ("gitlab_project_sync_id") REFERENCES "gitlab_project_syncs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_gitlab_sources" ADD CONSTRAINT "board_gitlab_sources_target_group_id_fkey" FOREIGN KEY ("target_group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_folders" ADD CONSTRAINT "board_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "board_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_folders" ADD CONSTRAINT "board_folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_board_prefs" ADD CONSTRAINT "user_board_prefs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_board_prefs" ADD CONSTRAINT "user_board_prefs_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_board_prefs" ADD CONSTRAINT "user_board_prefs_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "board_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_employees" ADD CONSTRAINT "org_employees_org_tree_id_fkey" FOREIGN KEY ("org_tree_id") REFERENCES "org_trees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_employees" ADD CONSTRAINT "org_employees_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "org_employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_tree_sources" ADD CONSTRAINT "org_tree_sources_org_tree_id_fkey" FOREIGN KEY ("org_tree_id") REFERENCES "org_trees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "board_calendar_sources" ADD CONSTRAINT "board_calendar_sources_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_employee_aliases" ADD CONSTRAINT "org_employee_aliases_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "org_employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_employee_comments" ADD CONSTRAINT "org_employee_comments_org_employee_id_fkey" FOREIGN KEY ("org_employee_id") REFERENCES "org_employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_employee_comments" ADD CONSTRAINT "org_employee_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_boards" ADD CONSTRAINT "employee_boards_org_tree_id_fkey" FOREIGN KEY ("org_tree_id") REFERENCES "org_trees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_boards" ADD CONSTRAINT "employee_boards_scope_employee_id_fkey" FOREIGN KEY ("scope_employee_id") REFERENCES "org_employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_groups" ADD CONSTRAINT "employee_groups_employee_board_id_fkey" FOREIGN KEY ("employee_board_id") REFERENCES "employee_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_board_members" ADD CONSTRAINT "employee_board_members_employee_board_id_fkey" FOREIGN KEY ("employee_board_id") REFERENCES "employee_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_board_members" ADD CONSTRAINT "employee_board_members_org_employee_id_fkey" FOREIGN KEY ("org_employee_id") REFERENCES "org_employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_board_members" ADD CONSTRAINT "employee_board_members_employee_group_id_fkey" FOREIGN KEY ("employee_group_id") REFERENCES "employee_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_columns" ADD CONSTRAINT "employee_columns_employee_board_id_fkey" FOREIGN KEY ("employee_board_id") REFERENCES "employee_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_field_values" ADD CONSTRAINT "employee_field_values_employee_column_id_fkey" FOREIGN KEY ("employee_column_id") REFERENCES "employee_columns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_field_values" ADD CONSTRAINT "employee_field_values_org_employee_id_fkey" FOREIGN KEY ("org_employee_id") REFERENCES "org_employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roadmap_access" ADD CONSTRAINT "roadmap_access_roadmap_id_fkey" FOREIGN KEY ("roadmap_id") REFERENCES "roadmaps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roadmap_access" ADD CONSTRAINT "roadmap_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roadmap_board_subscriptions" ADD CONSTRAINT "roadmap_board_subscriptions_roadmap_id_fkey" FOREIGN KEY ("roadmap_id") REFERENCES "roadmaps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roadmap_board_subscriptions" ADD CONSTRAINT "roadmap_board_subscriptions_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roadmap_groups" ADD CONSTRAINT "roadmap_groups_roadmap_id_fkey" FOREIGN KEY ("roadmap_id") REFERENCES "roadmaps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roadmap_groups" ADD CONSTRAINT "roadmap_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roadmap_views" ADD CONSTRAINT "roadmap_views_roadmap_id_fkey" FOREIGN KEY ("roadmap_id") REFERENCES "roadmaps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roadmap_gantt_configs" ADD CONSTRAINT "roadmap_gantt_configs_roadmap_view_id_fkey" FOREIGN KEY ("roadmap_view_id") REFERENCES "roadmap_views"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roadmap_prefs" ADD CONSTRAINT "user_roadmap_prefs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roadmap_prefs" ADD CONSTRAINT "user_roadmap_prefs_roadmap_id_fkey" FOREIGN KEY ("roadmap_id") REFERENCES "roadmaps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roadmap_prefs" ADD CONSTRAINT "user_roadmap_prefs_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "board_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_tree_timesheet_configs" ADD CONSTRAINT "org_tree_timesheet_configs_org_tree_id_fkey" FOREIGN KEY ("org_tree_id") REFERENCES "org_trees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

