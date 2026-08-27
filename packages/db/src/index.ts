export { PrismaClient, Prisma } from "@prisma/client";
// `chInsertManyWith` is the injectable-client core of `chInsertMany` — same tenant
// stamp, same empty-organizationId refusal, same chunking. Exported so an
// integration suite can write through the PRODUCTION path against a throwaway
// client instead of calling `client.insert` directly, which is how three
// dual-writer suites came to write `organization_id = ''` and assert nothing about
// the tenant stamp.
export { clickhouse, chInsertMany, chInsertManyWith } from "./clickhouse";
export type { ClickHouseClient } from "./clickhouse";
export {
  runClickhouseMigrations,
} from "./clickhouse-migrate";
export type {
  ClickhouseExecClient,
  ClickhouseMigrationOptions,
  ClickhouseMigrationResult,
} from "./clickhouse-migrate";
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
  Organization,
  OrgMembership,
  Notification,
  NotificationPreference,
  BoardNotificationSetting,
} from "@prisma/client";
export type {
  BoardAccessRole,
  BoardViewType,
  SyncSource,
  OrgRole,
  OrgMembershipStatus,
} from "@prisma/client";
// A VALUE export, not type-only: the notification kinds are iterated at runtime
// (the shared Zod enum is asserted against this list, so a migration that adds a
// kind and forgets the schema fails a test instead of a production write).
export { NotificationKind } from "@prisma/client";
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
} from "@prisma/client";
export type { TimesheetStatusRule, TimesheetRuleScope } from "@prisma/client";
export { CH_TENANT_TABLES } from "./ch-tenancy-tables";
export type { ChTenantTable } from "./ch-tenancy-tables";
export {
  catchAllDenyDdl,
  organizationPolicyDdl,
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
} from "./ch-row-policies";
export type { ChPolicyObjects, ChPolicyQueryClient } from "./ch-row-policies";
export {
  applyRowPolicyBaseline,
  chExecutorFromClient,
  provisionOrganizationAnalytics,
  reprovisionOrganizations,
  retrofitReadIdentityGrants,
  resolveApiReadIdentityUser,
  resolveServiceIdentityUser,
  CH_DEFAULT_SERVICE_USER,
} from "./ch-provisioning";
export type {
  ChBaselineOptions,
  ChCommandClient,
  ChCoverageReport,
  ChProvisionResult,
  ReadIdentityRetrofitReport,
  ChStatementExecutor,
} from "./ch-provisioning";
