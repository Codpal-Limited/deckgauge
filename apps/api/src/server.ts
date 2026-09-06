import Fastify from "fastify";
import cors from "@fastify/cors";
import { resolveCorsOrigin } from "./cors-origins.js";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { mkdirSync } from "node:fs";
import { PrismaClient, chExecutorFromClient, clickhouse } from "@deckgauge/db";
import { ClickhouseIntelligenceService } from "./intelligence/clickhouse-intelligence.service.js";
import { buildChReadIdentity } from "./analytics/ch-read-client.js";
import { buildChReadPlugin } from "./analytics/ch-read.plugin.js";
import { intelligenceRoutes } from "./intelligence/intelligence.routes.js";
import { buildIntelligenceQueues } from "./intelligence/queues.js";
import { boardRoutes } from "./boards/board.routes.js";
import { recruitmentRoutes } from "./recruitment/recruitment.routes.js";
import { calendarSourceRoutes } from "./recruitment/calendar-source.routes.js";
import { projectRoutes } from "./projects/project.routes.js";
import { groupRoutes } from "./groups/group.routes.js";
import { columnRoutes } from "./columns/column.routes.js";
import { automationRoutes } from "./automations/automation.routes.js";
import { jiraInstanceRoutes } from "./jira-instances/jira-instance.routes.js";
import { retiredProjectsRoutes } from "./retired-projects/retired-projects.routes.js";
import { organizationRoutes } from "./organizations/organization.routes.js";
import { orgBoardsRoutes } from "./organizations/org-boards.routes.js";
import { commentRoutes } from "./comments/comment.routes.js";
import { ownerRoutes } from "./owners/owner.routes.js";
import { boardStatusRoutes } from "./board-statuses/board-status.routes.js";
import { uploadRoutes } from "./uploads/upload.routes.js";
import { UploadService } from "./uploads/upload.service.js";
import { resolveUploadsDir } from "./uploads/uploads-dir.js";
import { githubRoutes } from "./github/github.routes.js";
import { azureDevOpsRoutes } from "./azure-devops/azure-devops.routes.js";
import { adoProjectSyncRoutes } from "./project-syncs/ado-project-sync.routes.js";
import { gitlabRoutes } from "./gitlab/gitlab.routes.js";
import { developerProfileRoutes } from "./developer-profiles/developer-profile.routes.js";
import { jiraProjectSyncRoutes } from "./project-syncs/jira-project-sync.routes.js";
import { githubRepoSyncRoutes } from "./project-syncs/github-repo-sync.routes.js";
import { gitlabProjectSyncRoutes } from "./project-syncs/gitlab-project-sync.routes.js";
import { boardJiraSourceRoutes } from "./board-sources/board-jira-source.routes.js";
import { boardGitHubSourceRoutes } from "./board-sources/board-github-source.routes.js";
import { boardGitHubPickerRoutes } from "./board-sources/board-github-picker.routes.js";
import { Octokit } from "@octokit/rest";
import { Queue } from "bullmq";
import {
  GITHUB_SYNC_QUEUE_NAMES,
  makeGitHubQueueClient,
  manualSyncJobPayload,
} from "@deckgauge/shared";
import { boardAdoSourceRoutes } from "./board-sources/board-ado-source.routes.js";
import { boardGitLabSourceRoutes } from "./board-sources/board-gitlab-source.routes.js";
import { buildKeycloakAuthPlugin } from "./auth/keycloak-auth.plugin.js";
import { buildPolicyPlugin } from "./auth/policy.plugin.js";
import { AUTHENTICATED, PUBLIC } from "./auth/policy.js";
import { boardAccessRoutes } from "./board-access/board-access.routes.js";
import { userRoutes } from "./users/user.routes.js";
import { notificationRoutes } from "./notifications/notification.routes.js";
import { notificationPreferenceRoutes } from "./notifications/notification-preference.routes.js";
import { boardViewRoutes } from "./widgets/board-views.routes.js";
import { dashboardWidgetRoutes } from "./widgets/dashboard-widgets.routes.js";
import { widgetDataRoutes } from "./widgets/widget-data.routes.js";
import { presetsRoutes } from "./widgets/presets.routes.js";
import { intelligenceQueryRoutes } from "./intelligence-query/routes.js";
import { advisorRoutes } from "./advisor/advisor.routes.js";
import { advisorHelpRoutes } from "./advisor/advisor-help.routes.js";
import { advisorConfigRoutes } from "./advisor/advisor-config.routes.js";
import { advisorSessionRoutes } from "./advisor/advisor-session.routes.js";
import { advisorChangeSetRoutes } from "./advisor/advisor-change-set.routes.js";
import { mcpRoutes } from "./mcp/mcp.routes.js";
import { boardSyncRoutes } from "./board-sync/board-sync.routes.js";
import { boardTreeRoutes } from "./board-tree/board-tree.routes.js";
import { roadmapRoutes } from "./roadmap/roadmap.routes.js";
import { comparisonRoutes } from "./comparison/comparison.routes.js";
import { orgTreeRoutes } from "./org-trees/org-tree.routes.js";
import { orgTreeTimesheetRoutes } from "./org-trees/org-tree-timesheet.routes.js";
import { buildOrgTreeAccessRoutes } from "./org-trees/org-tree-access.routes.js";
import { buildEmployeeBoardAccessRoutes } from "./employee-boards/employee-board-access.routes.js";
import { buildComparisonAccessRoutes } from "./comparison/comparison-access.routes.js";
import { buildRoadmapAccessRoutes } from "./roadmaps/roadmap-access.routes.js";
import { OrgTreeService } from "./org-trees/org-tree.service.js";
import { OrgSourceService } from "./org-trees/org-source.service.js";
import { employeeBoardRoutes } from "./employee-boards/employee-board.routes.js";
import { EmployeeBoardService } from "./employee-boards/employee-board.service.js";
import { roadmapsRoutes } from "./roadmaps/roadmap.routes.js";
import { TimesheetService } from "./timesheet/timesheet.service.js";
import { timesheetRoutes } from "./timesheet/timesheet.routes.js";
import { buildTimesheetDeps } from "./timesheet/timesheet-deps.js";
import { locationRoutes } from "./locations/location.routes.js";
import { advisorConfigFromEnv } from "./advisor/advisor-config-env.js";
import { loadEnterprise, COMMUNITY_STATUS } from "./enterprise-loader.js";
import type { RouteHost } from "./enterprise-contract.js";

export function buildServer(prisma: PrismaClient) {
  // Configured, never derived from the working directory: deriving it resolved
  // to the api container's ephemeral layer and silently destroyed six comment
  // images. See ./uploads/uploads-dir.ts and
  // ./__isolation__/uploads-persistence.test.ts.
  const uploadsDir = resolveUploadsDir();
  mkdirSync(uploadsDir, { recursive: true });

  const app = Fastify({ logger: true });
  const enterprisePromise = loadEnterprise();

  // @fastify/cors registers a global `OPTIONS *` preflight route internally
  // (`fastify.options('*', { schema: {...} }, ...)` — see its source; there is
  // no option to pass it a `config`). It sits outside `protectedApp` just like
  // `/health` below, so `buildPolicyPlugin`'s boot assertion never sees it
  // either way — but route-inventory.test.ts's own onRoute hook (attached
  // directly to this `app`, which sees every route in the whole tree) does,
  // and reports it MISSING. Stamp it PUBLIC the moment it's registered, since
  // it can't be labeled at its own registration call: this is a CORS
  // preflight route, browser-initiated, carries no Authorization header per
  // spec, and its handler is a no-op `reply.send()` — same "no board, no
  // policy needed" class as /health. Must run before `app.register(cors...)`.
  app.addHook("onRoute", (route) => {
    if (route.method === "OPTIONS" && route.url === "*" && !route.config?.policy) {
      route.config = { ...route.config, policy: PUBLIC };
    }
  });

  app.register(cors, { origin: resolveCorsOrigin(process.env) });
  app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 300),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute",
  });
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // Nested (not a bare top-level `.get()`) so its registration defers into
  // avvio's boot queue like every other route family below, rather than
  // being added synchronously before a test could attach its own `onRoute`
  // hook. It stays outside the `protectedApp` context below — the policy
  // plugin never enforces it — so `config.policy` here is documentation and
  // route-inventory data, not enforcement.
  app.register(async (instance) => {
    instance.get("/health", { config: { policy: PUBLIC } }, async (_req, reply) => {
      return reply.send({ status: "ok" });
    });
  });

  // An ADVISOR_PROVIDER that doesn't yield a usable config (typo'd provider,
  // missing model/key, base URL without its scheme) degrades silently to
  // "advisor not configured" — say so at boot rather than leaving the
  // operator to wonder why their .env had no effect.
  if (process.env.ADVISOR_PROVIDER && !advisorConfigFromEnv(process.env)) {
    app.log.warn(
      { provider: process.env.ADVISOR_PROVIDER },
      "ADVISOR_PROVIDER is set but the advisor env config is incomplete or invalid — " +
        "the advisor will report itself unconfigured. Check ADVISOR_MODEL and " +
        "ADVISOR_ANTHROPIC_API_KEY / ADVISOR_OLLAMA_BASE_URL (the base URL needs an http:// or https:// scheme).",
    );
  }

  const uploadService = new UploadService(prisma, uploadsDir);

  // Protected routes — all require a valid Keycloak JWT
  app.register(async (protectedApp) => {
    const enterprise = await enterprisePromise;
    protectedApp.register(
      buildKeycloakAuthPlugin(prisma, {
        onUserAuthenticated: enterprise?.onUserAuthenticated?.bind(enterprise),
        restrictMembership: enterprise?.restrictMembership?.bind(enterprise),
      }),
    );
    const singleUser = process.env.DECKGAUGE_SINGLE_USER === "true";
    await protectedApp.register(
      buildPolicyPlugin(prisma, {
        singleUser,
        restrictDenial: enterprise?.restrictDenial?.bind(enterprise),
      }),
    );
    // The ClickHouse read chokepoint. Registered AFTER the auth plugin, because
    // it reads `request.membership`, and after the policy plugin so that a
    // request which is going to be refused never builds a reader at all.
    const chReadIdentity = buildChReadIdentity({
      ingestClient: clickhouse,
      log: { warn: (m) => protectedApp.log.warn(m), info: (m) => protectedApp.log.info(m) },
    });
    await protectedApp.register(buildChReadPlugin({ identity: chReadIdentity }));

    protectedApp.register(boardAccessRoutes, { prisma });
    protectedApp.register(userRoutes, { prisma });
    protectedApp.register(commentRoutes, { prisma, uploadService });
    protectedApp.register(notificationRoutes, { prisma });
    protectedApp.register(notificationPreferenceRoutes, { prisma });
    protectedApp.register(boardRoutes, { prisma });
    protectedApp.register(recruitmentRoutes, { prisma });
    // Calendar→candidate ingest queue. Reuses the REDIS_URL env pattern as the other
    // queues below; falls back to no enqueue fn (route returns 503) when unset.
    const calendarSyncConnection = process.env.REDIS_URL
      ? { url: process.env.REDIS_URL }
      : null;
    const calendarSourceSyncQueue = calendarSyncConnection
      ? new Queue('calendar-source-sync', { connection: calendarSyncConnection })
      : null;
    protectedApp.register(calendarSourceRoutes, {
      prisma,
      enqueueCalendarSync: async (boardId) => {
        if (!calendarSourceSyncQueue) throw new Error('calendar sync queue unavailable');
        await calendarSourceSyncQueue.add('calendar-source-sync', { boardId });
      },
    });
    protectedApp.register(boardTreeRoutes, { prisma });
    protectedApp.register(projectRoutes, { prisma });
    protectedApp.register(groupRoutes, { prisma });
    protectedApp.register(columnRoutes, { prisma });
    protectedApp.register(automationRoutes, { prisma });
    protectedApp.register(jiraInstanceRoutes, { prisma });
    protectedApp.register(retiredProjectsRoutes, { prisma });
    // The one place the live ClickHouse client is bound to organization
    const entitledFeatures = enterprise
      ? enterprise.enabledFeatures(await enterprise.verifyLicense())
      : [];

    // provisioning. Kept out of organization.routes.ts so route tests that
    // register the plugin cannot reach the server behind clickhouse.ts's
    // hard-coded localhost:8123 fallback.
    protectedApp.register(organizationRoutes, {
      prisma,
      chExec: chExecutorFromClient(clickhouse),
      // Open-core seam: an edition may have something to tell this caller. The
      // route sanitises the result and omits the field entirely when there is
      // nothing, so the Community payload is unchanged.
      notices: enterprise?.notices?.bind(enterprise),
      // The multi-org entitlement. Resolved once here, where `enterprise` is
      // already awaited, and via the module's own `enabledFeatures` rather than
      // `status.features` — the module decides what a given status actually
      // entitles, so an expired licence yields none. No module means no features,
      // which is what refuses a second organization on the open-source edition.
      entitledFeatures: () => entitledFeatures,
    });
    protectedApp.register(orgBoardsRoutes, { prisma });
    protectedApp.register(ownerRoutes, { prisma });
    protectedApp.register(boardStatusRoutes, { prisma });
    protectedApp.register(uploadRoutes, { service: uploadService });
    protectedApp.register(githubRoutes, { prisma });
    protectedApp.register(azureDevOpsRoutes, { prisma });
    protectedApp.register(adoProjectSyncRoutes({ prisma, singleUser }));
    protectedApp.register(gitlabRoutes({ prisma, singleUser }));
    protectedApp.register(developerProfileRoutes({ prisma }));
    protectedApp.register(jiraProjectSyncRoutes({ prisma, singleUser }));
    protectedApp.register(githubRepoSyncRoutes({ prisma, singleUser }));
    protectedApp.register(gitlabProjectSyncRoutes({ prisma, singleUser }));
    protectedApp.register(boardJiraSourceRoutes({ prisma, clickhouse }));

    // Three-tier BullMQ queue client for GitHub bulk-repo ingestion.
    // Matches the worker's queue names + repeat intervals (see
    // @deckgauge/shared GITHUB_SYNC_QUEUE_NAMES). When REDIS_URL is unset
    // we fall back to a no-op so the api still boots in unit-test contexts.
    const githubBulkConnection = process.env.REDIS_URL
      ? { url: process.env.REDIS_URL }
      : null;
    const githubQueueClient = githubBulkConnection
      ? makeGitHubQueueClient({
          hot: new Queue(GITHUB_SYNC_QUEUE_NAMES.hot, { connection: githubBulkConnection }),
          warm: new Queue(GITHUB_SYNC_QUEUE_NAMES.warm, { connection: githubBulkConnection }),
          cold: new Queue(GITHUB_SYNC_QUEUE_NAMES.cold, { connection: githubBulkConnection }),
        })
      : undefined;

    protectedApp.register(
      boardGitHubSourceRoutes({ prisma, clickhouse, queueClient: githubQueueClient }),
    );
    protectedApp.register(
      boardGitHubPickerRoutes({
        prisma,
        // Octokit factory keyed by GitHubInstance row. Honors GHE baseUrl
        // when set; accessToken is read per-call and never logged.
        octokitFor: (instance) =>
          new Octokit({
            auth: instance.accessToken,
            baseUrl: instance.baseUrl ?? "https://api.github.com",
          }),
      }),
    );
    protectedApp.register(boardAdoSourceRoutes({ prisma, clickhouse }));
    protectedApp.register(boardGitLabSourceRoutes({ prisma, clickhouse }));
    protectedApp.register(boardViewRoutes, { prisma });
    protectedApp.register(dashboardWidgetRoutes, { prisma });
    protectedApp.register(widgetDataRoutes, { prisma, singleUser });
    protectedApp.register(presetsRoutes, { prisma });
    protectedApp.register(intelligenceQueryRoutes, { prisma });
    protectedApp.register(advisorRoutes({ prisma, clickhouse }));
    protectedApp.register(advisorHelpRoutes({ prisma }));
    protectedApp.register(advisorConfigRoutes({ prisma }));
    protectedApp.register(advisorSessionRoutes({ prisma }));
    protectedApp.register(advisorChangeSetRoutes(prisma));
    protectedApp.register(mcpRoutes({ prisma, clickhouse }));
    protectedApp.register(roadmapRoutes, { prisma });
    protectedApp.register(roadmapsRoutes, { prisma });
    protectedApp.register(comparisonRoutes, { prisma });

    // Org-tree sync queue. Reuses the same REDIS_URL env var pattern as the
    // GitHub bulk-ingestion queues above; falls back to no-op when unset.
    const orgTreeSyncConnection = process.env.REDIS_URL
      ? { url: process.env.REDIS_URL }
      : null;
    const orgTreeSyncQueue = orgTreeSyncConnection
      ? new Queue('org-tree-sync', { connection: orgTreeSyncConnection })
      : null;
    const orgSourceSyncQueue = orgTreeSyncConnection
      ? new Queue('org-source-sync', { connection: orgTreeSyncConnection })
      : null;
    protectedApp.register(
      employeeBoardRoutes({ serviceFactory: () => new EmployeeBoardService(prisma) }),
    );
    protectedApp.register(
      orgTreeRoutes({
        serviceFactory: () => new OrgTreeService(prisma),
        clickhouse,
        prisma,
        uploadService,
        enqueueSync: async (treeId) => {
          if (!orgTreeSyncQueue) throw new Error('org-tree sync queue unavailable');
          await orgTreeSyncQueue.add('org-tree-sync', { treeId });
        },
        sourceService: new OrgSourceService(prisma),
        enqueueSourceSync: async (treeId) => {
          if (!orgSourceSyncQueue) throw new Error('org-source sync queue unavailable');
          await orgSourceSyncQueue.add('org-source-sync', { treeId });
        },
      }),
    );
    protectedApp.register(buildOrgTreeAccessRoutes(prisma));
    protectedApp.register(buildEmployeeBoardAccessRoutes(prisma));
    protectedApp.register(buildComparisonAccessRoutes(prisma));
    protectedApp.register(buildRoadmapAccessRoutes(prisma));

    // EI-019 — Phase 3 intelligence routes.
    //
    // `clickhouse` is the INGEST singleton, and it holds `ingest_all … USING 1`
    // on every object — so a read through it cannot be narrowed by any
    // per-organization row policy (tenancy §11 precondition 8). Reads therefore
    // go through `request.chRead`, a reader scoped to the caller's organization
    // by the plugin registered below; this boot-time service stays only for the
    // paths that have not been converted yet, and each of those is named in
    // planning/STATE.md.
    const intelligenceService = new ClickhouseIntelligenceService({ client: clickhouse });

    // EI-022 — manual sync trigger. Wires BullMQ Queue clients to the
    // intelligence-sync queues the worker manages. When REDIS_URL isn't
    // set we leave enqueueSync undefined and the route returns 503 (graceful).
    const queues = buildIntelligenceQueues(process.env.REDIS_URL);
    const enqueueSync = queues
      ? async (
          source: 'jira' | 'github' | 'ado' | 'gitlab' | 'all',
          organizationId: string,
        ) => {
          // Built by the shared helper, not inline. This is the enqueue site that was
          // MISSED when the others were scoped: it sent
          // `{ trigger: 'manual' }` with no tenant, which the (now fail-closed) worker
          // handlers refuse — the route had already answered 202, so the UI reported a
          // successful sync while nothing synced. `manualSyncJobPayload` takes the
          // organization as its only argument, so an enqueue site cannot compile
          // without one.
          const payload = manualSyncJobPayload(organizationId);
          if (source === 'all') {
            await Promise.all([
              queues.jira.add('manual', payload),
              queues.github.add('manual', payload),
              queues.ado.add('manual', payload),
              queues.gitlab.add('manual', payload),
            ]);
            return;
          }
          await queues[source].add('manual', payload);
        }
      : undefined;

    protectedApp.register(intelligenceRoutes({ service: intelligenceService, prisma, enqueueSync }));
    protectedApp.register(boardSyncRoutes({ prisma, queues }));

    // One TimesheetService — its TtlCache is per-instance and the timesheet
    // engine is the most expensive read in the product — but a reader resolved
    // PER ORGANIZATION on every ClickHouse call (tenancy §11 precondition 8).
    const timesheetService = new TimesheetService(
      buildTimesheetDeps(prisma, (organizationId) => chReadIdentity.readerFor(organizationId)),
    );
    protectedApp.register(timesheetRoutes({ service: timesheetService, prisma }));
    protectedApp.register(orgTreeTimesheetRoutes({ prisma, clickhouse }));
    protectedApp.register(locationRoutes);

    // Open-core seam, authenticated half. The public half (registerRoutes, below)
    // serves the unauthenticated status endpoint, so a route that reads
    // request.membership has to be registered here instead — after the auth and
    // policy plugins above. A no-op in Community, where the module is absent.
    if (enterprise?.registerProtectedRoutes) {
      const status = await enterprise.verifyLicense();
      // `RouteHost.get`/`post` take a path and a handler and nothing else, so an
      // edition has no way to declare `config: { policy }` — while the policy
      // plugin refuses to finish booting if any route in this context declares
      // none. The core therefore supplies it, which is the right side of the seam
      // for it to live on: an edition cannot forget it, and cannot widen it.
      //
      // AUTHENTICATED rather than an org-scoped policy because these handlers do
      // their own tenant check and answer NO_ORGANIZATION for a caller without a
      // membership — a policy-level rejection would replace that answer with a
      // generic refusal.
      const policedHost: RouteHost = {
        get: (path, handler) =>
          protectedApp.get(path, { config: { policy: AUTHENTICATED } }, handler as never),
        post: (path, handler) =>
          protectedApp.post(path, { config: { policy: AUTHENTICATED } }, handler as never),
        addContentTypeParser: (contentType, options, parser) =>
          protectedApp.addContentTypeParser(contentType, options, parser as never),
      };
      await enterprise.registerProtectedRoutes(policedHost, status);
    }
  });

  // Open-core seam. When DECKGAUGE_EDITION=enterprise and the private
  // @deckgauge/enterprise module is present, load it and let it register its
  // (license-gated) routes. In the Community build the module is absent, this is
  // a no-op, and the platform runs fully as open source.
  // See planning/OPEN-CORE-ARCHITECTURE.md.
  //
  // Registered outside `protectedApp`, same as /health above — the policy
  // plugin never enforces this route, so `config.policy: PUBLIC` here is
  // documentation and route-inventory data, not enforcement. It's an
  // informational status endpoint (edition/license-state/feature flags, no
  // secrets), the same "safe to be unauthenticated" class as /health.
  app.register(async (entApp) => {
    const enterprise = await enterprisePromise;
    if (enterprise) {
      const status = await enterprise.verifyLicense();
      await enterprise.registerRoutes(entApp as unknown as RouteHost, status);
    } else {
      entApp.get("/enterprise/status", { config: { policy: PUBLIC } }, async () => ({
        edition: COMMUNITY_STATUS.edition,
        licenseState: COMMUNITY_STATUS.state,
        features: COMMUNITY_STATUS.features,
        message: COMMUNITY_STATUS.message,
      }));
    }
  });

  return app;
}
