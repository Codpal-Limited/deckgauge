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
import {
  ANALYTICS,
  ORG_ADMIN,
  all,
  orgRole,
  orgTree,
  viaOrgTreeId,
  fromQuery,
} from '../auth/policy.js';
import { requireOrganizationId } from '../organizations/request-organization.js';

export interface TimesheetRoutesDeps {
  service: TimesheetService;
  prisma: PrismaClient;
}

/**
 * Hours are org-tree data, and nothing more (design D13).
 *
 * These three reads used to pair `orgTree(VIEWER)` with `ANALYTICS`, a Keycloak
 * realm role that is not tenant-scoped and cannot be granted by sharing. So an
 * org-tree viewer without that role got 403 on the Timesheet tab of a tree
 * deliberately shared with them — design §1.6 records "sharing an org tree
 * shares its timesheet" as only half-true because of it. Dropping `ANALYTICS`
 * here is what makes it true.
 *
 * The tree gate is what still decides: a caller with no grant on the tree named
 * in `?orgTreeId=` is denied exactly as before. This is an authorization
 * LOOSENING and it is deliberate — anyone holding an org-tree grant can now read
 * the hours grid.
 */
const TIMESHEET_TREE = orgTree('VIEWER', viaOrgTreeId(fromQuery('orgTreeId')));

/**
 * Cost keeps both gates. `/capex-report` renders blended-rate cost in currency,
 * and per-person cost visibility is sub-project 6's subject — it must not become
 * a side effect of sharing an org chart (design D13). `ANALYTICS` is checked
 * first so a caller lacking the realm role is denied without a database lookup.
 *
 * `GET /timesheet/status-rules` carries no tree id at all, so it pairs
 * `ANALYTICS` with an organization floor instead — it needs a membership to
 * scope its query to, which `ANALYTICS` alone cannot supply.
 */
const TIMESHEET_COST = all(
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
      return reply.send(await service.getGrid(requireOrganizationId(req), parsed.data));
    });

    app.get('/timesheet/capex-report', { config: { policy: TIMESHEET_COST } }, async (req, reply) => {
      const parsed = CapexReportQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      return reply.send(await service.getCapexReport(requireOrganizationId(req), parsed.data));
    });

    app.get('/timesheet/epic-breakdown', { config: { policy: TIMESHEET_TREE } }, async (req, reply) => {
      const parsed = EpicBreakdownQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      return reply.send(await service.getEpicBreakdown(requireOrganizationId(req), parsed.data));
    });

    app.get('/timesheet/intervals', { config: { policy: TIMESHEET_TREE } }, async (req, reply) => {
      const parsed = IntervalsQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      return reply.send(await service.getIntervals(requireOrganizationId(req), parsed.data));
    });

    app.get(
      '/timesheet/status-rules',
      { config: { policy: all(ANALYTICS, orgRole('VIEWER')) } },
      async (req, reply) => {
        const rules = (await prisma.timesheetStatusRule.findMany({
          where: { organizationId: requireOrganizationId(req) },
        })) as RuleRow[];
        return reply.send(rules.map(toDto));
      },
    );

    // Replace-all semantics, now scoped. Both halves needed fixing and the
    // delete was the dangerous one: `deleteMany({})` with no filter removed
    // EVERY organization's rules before writing the caller's back, so one
    // organization saving its rules would silently wipe every other tenant's.
    // The unscoped read above fed the same wrong set into this write, which is
    // how another tenant's rules got copied into the caller's — or collided on
    // the now-composite unique index.
    app.put('/timesheet/status-rules', { config: { policy: ORG_ADMIN } }, async (req, reply) => {
      const parsed = PutStatusRulesSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const organizationId = requireOrganizationId(req);
      const created = (await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.timesheetStatusRule.deleteMany({ where: { organizationId } });
        await tx.timesheetStatusRule.createMany({
          data: parsed.data.rules.map((r) => ({ ...r, organizationId })),
        });
        return tx.timesheetStatusRule.findMany({ where: { organizationId } });
      })) as RuleRow[];
      return reply.send(created.map(toDto));
    });
  };
}
