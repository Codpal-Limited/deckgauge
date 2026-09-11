export { PrismaClient, Prisma } from "./generated/prisma/client.js";
export { createPrismaClient } from "./client.js";
// `chInsertManyWith` is the injectable-client core of `chInsertMany` — same tenant
// stamp, same empty-organizationId refusal, same chunking. Exported so an
// integration suite can write through the PRODUCTION path against a throwaway
// client instead of calling `client.insert` directly, which is how three
// dual-writer suites came to write `organization_id = ''` and assert nothing about
// the tenant stamp.
export { clickhouse, chInsertMany, chInsertManyWith } from "./clickhouse.js";
export type { ClickHouseClient } from "./clickhouse.js";
export {
  runClickhouseMigrations,
} from "./clickhouse-migrate.js";
export type {
  ClickhouseExecClient,
  ClickhouseMigrationOptions,
  ClickhouseMigrationResult,
} from "./clickhouse-migrate.js";
export type {
  Project,
  Board,
  Group,
  BoardOwner,
  BoardStatus,
  BoardCalendarEvent,
  BoardCalendarSource,
  BoardSyncExclusion,
  SyncRun,
  GitHubInstance,
  BoardAccess,
  User,
  BoardView,
  Comparison,
  ComparisonMember,
  RoadmapConfig,
  BoardFolder,
  UserBoardPref,
  AzureDevOpsProjectSync,
  AdoRepoSyncState,
  OrgTree,
  OrgTreeAccess,
  EmployeeBoardAccess,
  ComparisonAccess,
  OrgEmployee,
  OrgEmployeeAlias,
  OrgTreeSource,
  OrgTreeTimesheetConfig,
  RetiredJiraProject,
  OrgEmployeeComment,
  CostClassification,
  EmployeeBoard,
  EmployeeGroup,
  EmployeeBoardMember,
  EmployeeColumn,
  EmployeeFieldValue,
  AdvisorConfig,
  AdvisorSession,
  AdvisorMessage,
  AdvisorChangeSet,
  Organization,
  OrgMembership,
  Notification,
  NotificationPreference,
  BoardNotificationSetting,
} from "./generated/prisma/client.js";
export type {
  BoardAccessRole,
  BoardViewType,
  SyncSource,
  OrgRole,
  OrgMembershipStatus,
  AdvisorChangeSetStatus,
} from "./generated/prisma/client.js";
// A VALUE export, not type-only: the notification kinds are iterated at runtime
// (the shared Zod enum is asserted against this list, so a migration that adds a
// kind and forgets the schema fails a test instead of a production write).
export { NotificationKind } from "./generated/prisma/client.js";
export type {
  Roadmap,
  RoadmapAccess,
  RoadmapBoardSubscription,
  RoadmapGroup,
  RoadmapView,
  RoadmapGanttConfig,
  UserRoadmapPref,
  RoadmapAccessRole,
  RoadmapGroupSource,
  RoadmapViewType,
} from "./generated/prisma/client.js";
export type { TimesheetStatusRule, TimesheetRuleScope } from "./generated/prisma/client.js";
export { CH_TENANT_TABLES } from "./ch-tenancy-tables.js";
export type { ChTenantTable } from "./ch-tenancy-tables.js";
export {
  catchAllDenyDdl,
  organizationPolicyDdl,
  organizationPolicyDropDdl,
  ingestIdentityDdl,
  readIdentityDefaultRoleDdl,
  readIdentityPermissivePolicyQuery,
  readIdentityRoleGrantDdl,
  roleNameFor,
  fetchPolicyObjects,
  sharedObjectAllowDdl,
  CH_POLICY_DATABASE,
  CH_SHARED_OBJECTS,
  CH_ALL_OBJECTS_QUERY,
  CH_TENANT_OBJECTS_QUERY,
  CH_ISO_POLICY_OBJECTS_QUERY,
  isoPolicyObjectsForOrganizationQuery,
} from "./ch-row-policies.js";
export type { ChPolicyObjects, ChPolicyQueryClient } from "./ch-row-policies.js";
export {
  applyRowPolicyBaseline,
  chExecutorFromClient,
  provisionOrganizationAnalytics,
  reprovisionOrganizations,
  retrofitReadIdentityGrants,
  resolveApiReadIdentityUser,
  resolveServiceIdentityUser,
  CH_DEFAULT_SERVICE_USER,
} from "./ch-provisioning.js";
export type {
  ChBaselineOptions,
  ChCommandClient,
  ChCoverageReport,
  ChProvisionResult,
  ReadIdentityRetrofitReport,
  ChStatementExecutor,
} from "./ch-provisioning.js";
export { EXCLUDE_DEMO_INSTANCE, EXCLUDE_DEMO_REPO_SYNC } from "./demo/sync-exclusion.js";

/**
 * Exported for the tsx-run scripts OUTSIDE this package — today
 * `apps/worker/src/scripts/trigger-org-sync.ts`, which needs the same
 * "invoked directly?" guard `seed-demo.ts` and `test-account.ts` use. It is
 * reachable only through this entry point (`packages/db` publishes no
 * `exports` map with subpaths), and the alternative was a second copy of two
 * lines whose correctness depends on `process.argv[1]` and `import.meta.url`
 * agreeing — exactly the thing not to have two of.
 */
export { isMainModule } from "./esm-main.js";
