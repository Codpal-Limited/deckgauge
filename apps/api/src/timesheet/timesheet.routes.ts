import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '@deckgauge/db';
import { Prisma } from '@deckgauge/db';
import {
  TimesheetGridQuerySchema,
  CapexReportQuerySchema,
  EpicBreakdownQuerySchema,
  IntervalsQuerySchema,
  PutStatusRulesSchema,
  type StatusRuleDto,
} from '@deckgauge/shared';
import type { TimesheetService } from './timesheet.service.js';
import { ANALYTICS, ADMIN, all, orgTree, viaOrgTreeId, fromQuery } from '../auth/policy.js';

export interface TimesheetRoutesDeps {
  service: TimesheetService;
  prisma: PrismaClient;
}

/**
 * The analytics realm role alone is not enough for these four reads: each
 * one carries an `orgTreeId` in its query, and per-engineer hours are the
 * same data domain `/org-trees/:id/timesheet-config` gates on `orgTree`
 * VIEWER. Without this, a caller holding `cockpit-analytics` could read any
 * tree's hours regardless of what they were actually granted. `ANALYTICS` is
 * checked first so a caller lacking the role is denied without a database
 * lookup. `GET /timesheet/status-rules` carries no tree id at all — it stays
 * plain `ANALYTICS`.
 */
const TIMESHEET_TREE = all(
  ANALYTICS,
  orgTree('VIEWER', viaOrgTreeId(fromQuery('orgTreeId'))),
);

interface RuleRow {
  id: string;
  scope: 'ROLE' | 'EMPLOYEE';
  role: string | null;
  employeeId: string | null;
  inProgressStatuses: string[];
}

function toDto(r: RuleRow): StatusRuleDto {
  return {
    id: r.id,
    scope: r.scope,
    role: r.role,
    employeeId: r.employeeId,
    inProgressStatuses: r.inProgressStatuses,
  };
}

export function timesheetRoutes(deps: TimesheetRoutesDeps): FastifyPluginAsync {
  return async function plugin(app: FastifyInstance) {
    const { service, prisma } = deps;

    app.get('/timesheet/grid', { config: { policy: TIMESHEET_TREE } }, async (req, reply) => {
      const parsed = TimesheetGridQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      return reply.send(await service.getGrid(parsed.data));
    });

    app.get('/timesheet/capex-report', { config: { policy: TIMESHEET_TREE } }, async (req, reply) => {
      const parsed = CapexReportQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      return reply.send(await service.getCapexReport(parsed.data));
    });

    app.get('/timesheet/epic-breakdown', { config: { policy: TIMESHEET_TREE } }, async (req, reply) => {
      const parsed = EpicBreakdownQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      return reply.send(await service.getEpicBreakdown(parsed.data));
    });

    app.get('/timesheet/intervals', { config: { policy: TIMESHEET_TREE } }, async (req, reply) => {
      const parsed = IntervalsQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      return reply.send(await service.getIntervals(parsed.data));
    });

    app.get('/timesheet/status-rules', { config: { policy: ANALYTICS } }, async (_req, reply) => {
      const rules = (await prisma.timesheetStatusRule.findMany()) as RuleRow[];
      return reply.send(rules.map(toDto));
    });

    app.put('/timesheet/status-rules', { config: { policy: ADMIN } }, async (req, reply) => {
      const parsed = PutStatusRulesSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const created = (await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.timesheetStatusRule.deleteMany({});
        await tx.timesheetStatusRule.createMany({ data: parsed.data.rules });
        return tx.timesheetStatusRule.findMany();
      })) as RuleRow[];
      return reply.send(created.map(toDto));
    });
  };
}
