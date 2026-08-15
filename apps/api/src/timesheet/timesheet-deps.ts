import type { PrismaClient } from '@deckgauge/db';
import {
  fetchTransitions,
  fetchParentLinks,
  fetchClassificationMap,
  fetchIssueMeta,
  type ChQueryClient,
} from './timesheet-fetch.js';
import type { TimesheetDeps } from './timesheet.service.js';
import { OrgTreeTimesheetConfigService } from '../org-trees/org-tree-timesheet-config.service.js';

/** Production wiring of TimesheetService dependencies (Prisma + ClickHouse). */
export function buildTimesheetDeps(prisma: PrismaClient, clickhouse: ChQueryClient): TimesheetDeps {
  const configService = new OrgTreeTimesheetConfigService(prisma);
  return {
    loadEmployees: async (orgTreeId: string) => {
      const where = orgTreeId ? { orgTreeId } : {};
      const rows = await prisma.orgEmployee.findMany({
        where,
        select: {
          id: true,
          name: true,
          role: true,
          managerId: true,
          aliases: { select: { provider: true, kind: true, value: true } },
        },
      });
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        managerId: r.managerId,
        aliases: r.aliases,
      }));
    },
    loadRules: async () => {
      const rows = await prisma.timesheetStatusRule.findMany();
      return rows.map((r) => ({
        scope: r.scope,
        role: r.role,
        employeeId: r.employeeId,
        inProgressStatuses: r.inProgressStatuses,
      }));
    },
    loadOrgTreeActiveStatuses: async (orgTreeId: string) => {
      const cfg = await configService.get(orgTreeId);
      return cfg ? cfg.activeStatuses : null;
    },
    loadOrgTreeDailyCapHours: async (orgTreeId: string) => {
      const cfg = await configService.get(orgTreeId);
      return cfg ? cfg.dailyCapHours : null;
    },
    fetchTransitions: (toMs: number) => fetchTransitions(clickhouse, toMs),
    loadRetiredProjects: async () => {
      const rows = await prisma.retiredJiraProject.findMany({
        select: { projectKey: true, cutoffDate: true },
      });
      return new Map(rows.map((r) => [r.projectKey.toUpperCase(), r.cutoffDate.getTime()]));
    },
    fetchParentLinks: () => fetchParentLinks(clickhouse),
    fetchClassificationMap: () => fetchClassificationMap(clickhouse),
    loadIssueMeta: () => fetchIssueMeta(clickhouse),
  };
}
