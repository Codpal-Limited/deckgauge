import type { PrismaClient } from '@deckgauge/db';
import { fetchTransitions, type ChQueryClient } from '../timesheet/timesheet-fetch.js';
import { makeAssigneeResolver } from '../timesheet/assignee-resolver.js';

interface Deps {
  prisma: PrismaClient;
  clickhouse: ChQueryClient;
  now?: () => number;
}

/**
 * The distinct statuses the timesheet could attribute to an org tree's people.
 * Reuses the engine's own transition fetch + fuzzy assignee resolver so the pool
 * exactly matches what the grid would attribute (alias-first, name fallback).
 */
export class OrgTreeStatusPoolService {
  private readonly prisma: PrismaClient;
  private readonly clickhouse: ChQueryClient;
  private readonly now: () => number;

  constructor(deps: Deps) {
    this.prisma = deps.prisma;
    this.clickhouse = deps.clickhouse;
    this.now = deps.now ?? Date.now;
  }

  async listForTree(orgTreeId: string): Promise<string[]> {
    const employees = await this.prisma.orgEmployee.findMany({
      where: { orgTreeId },
      select: { id: true, name: true, aliases: { select: { provider: true, kind: true, value: true } } },
    });
    if (employees.length === 0) return [];

    const resolve = makeAssigneeResolver(employees);
    // `from = 0` deliberately: this is the pool of statuses an operator can pick
    // from, so it must be every status ever seen, not just those touched in some
    // window — a status would otherwise vanish from the config screen and silently
    // stop counting. 0 reproduces the old unbounded lower bound exactly (see
    // timesheet-fetch.ts). This one scan is therefore still unbounded by design;
    // it runs on a config screen, not the timesheet read path.
    const transitions = await fetchTransitions(this.clickhouse, 0, this.now());

    const statuses = new Set<string>();
    for (const t of transitions) {
      if (!t.status) continue;
      if (resolve(t.assignee, t.provider) === null) continue;
      statuses.add(t.status);
    }
    return [...statuses].sort();
  }
}
