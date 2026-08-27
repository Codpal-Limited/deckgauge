import type { PrismaClient } from '@deckgauge/db';
import {
  normalizeOrgRows,
  resolveHierarchy,
  wouldCreateCycle,
  computeRanking,
  EmployeeStatsSchema,
  type RawOrgRow,
  type ImportResult,
  type OrgTreeDto,
  type OrgEmployeeDto,
  type EmployeeRankingDto,
  type RankingInput,
  type SyncStatus,
  type UpdateEmployeeProfileInput,
} from '@deckgauge/shared';
import { toOrgEmployeeDto } from './org-employee-dto.js';

export class OrgTreeCycleError extends Error {
  constructor(message = 'move would create a cycle') {
    super(message);
    this.name = 'OrgTreeCycleError';
  }
}

export class OrgEmployeeForbiddenError extends Error {
  constructor(message = 'not permitted to edit salary') {
    super(message);
    this.name = 'OrgEmployeeForbiddenError';
  }
}

/**
 * Thrown when a write names OrgEmployee ids that do not belong to the org tree
 * the request was authorized against.
 *
 * The rule: a route policy gates ONE entity — the `:boardId`, the `:id`, the
 * subject employee. Every other employee id the handler then acts on arrives
 * from the body or query and has been gated by nothing. Those ids must be
 * confirmed to live in the same tree, or the request is refused; otherwise the
 * caller reaches rows in a tree they hold nothing on, through a resource they
 * legitimately own.
 *
 * The whole request is refused — never partially applied with the offending
 * ids trimmed out. A silent trim hides a deliberate attempt, and gives a
 * legitimate caller who mistyped an id a success response that quietly did
 * less than they asked. Same call made in `BoardAccessDeniedError`
 * (auth/board-access.ts) for the board-set equivalent. The ids are carried so
 * the route can answer with something diagnosable.
 */
export class CrossTreeEmployeeError extends Error {
  constructor(public readonly orgEmployeeIds: string[]) {
    super(`Forbidden: employee(s) ${orgEmployeeIds.join(', ')} do not belong to this org tree`);
    this.name = 'CrossTreeEmployeeError';
  }
}

/** Minimal shape needed to rank an employee within its tree. */
interface RankableEmployee {
  id: string;
  isVacancy: boolean;
  departedAt: Date | null;
  matched: boolean;
  statsJson: unknown;
}

/**
 * Compute the tree-relative leaderboard for a set of employees. Only real, matched,
 * still-present employees with stored ranking counts take part — vacancies, departed
 * people, and unmatched rows are excluded so they neither skew the min-max
 * normalization nor inflate `totalRanked`. Returns a map keyed by employeeId; anyone
 * excluded is simply absent (the DTO layer maps that to `ranking: null`).
 */
export function computeTreeRanking(
  employees: RankableEmployee[],
): Map<string, EmployeeRankingDto> {
  const inputs: RankingInput[] = [];
  for (const e of employees) {
    if (e.isVacancy || e.departedAt != null || !e.matched) continue;
    const parsed = e.statsJson ? EmployeeStatsSchema.safeParse(e.statsJson) : null;
    if (parsed && parsed.success && parsed.data.ranking) {
      inputs.push({ employeeId: e.id, counts: parsed.data.ranking });
    }
  }
  return computeRanking(inputs);
}

export interface OrgTreeSummary {
  id: string;
  name: string;
  position: number;
  lastSyncedAt: string | null;
}

export class OrgTreeService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Create a tree and, when a creator is known, stamp them as its OWNER in
   * the same transaction — a tree whose access row didn't land would be
   * invisible to its own creator and recoverable only by an admin.
   */
  async create(
    organizationId: string,
    name: string,
    createdByUserId?: string,
  ): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      // The aggregate is scoped too, not just the create. §11 precondition 4 of
      // the tenancy design lists this unscoped `_max` as a live defect: a new
      // tree's position would otherwise be pushed up by another tenant's trees,
      // leaving gaps in this organization's ordering.
      const max = await tx.orgTree.aggregate({
        where: { organizationId },
        _max: { position: true },
      });
      const row = await tx.orgTree.create({
        data: { organizationId, name, position: (max._max.position ?? -1) + 1 },
      });
      if (createdByUserId) {
        await tx.orgTreeAccess.create({
          data: { orgTreeId: row.id, userId: createdByUserId, role: 'OWNER' },
        });
      }
      return { id: row.id };
    });
  }

  /** Rename a tree. Returns the updated summary, or null when the tree is gone. */
  async rename(id: string, name: string): Promise<OrgTreeSummary | null> {
    const existing = await this.prisma.orgTree.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return null;
    const row = await this.prisma.orgTree.update({ where: { id }, data: { name } });
    return {
      id: row.id,
      name: row.name,
      position: row.position,
      lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    };
  }

  /**
   * List trees, optionally restricted to `organizationId` and/or `orgTreeIds`.
   *
   * The two clauses are independent and AND together. `organizationId` is the
   * TENANT boundary; `orgTreeIds` is the caller's reach INSIDE a tenant. Passing
   * both is the normal case for a member, and passing the tenant alone is what an
   * organization admin gets — "every tree" has always meant every tree in the
   * caller's organization, and until `GET /org-trees` supplied this it meant
   * every tree in the deployment.
   *
   * An empty `orgTreeIds` array must yield an empty result, not every tree —
   * `=== undefined` (not a falsy/length check) is what distinguishes "no filter"
   * from "filter to nothing", since `{ id: { in: [] } }` and omitting the clause
   * entirely are very different queries to Prisma. The same test applies to
   * `organizationId`, and composing the two must not let either resurrect the
   * other's omission into "no filter at all" — hence one predicate assembled from
   * two independent decisions rather than a nested ternary.
   *
   * ### `organizationId` is optional and therefore FAILS OPEN — know this
   *
   * Omitting it returns every organization's trees, silently. That is not a
   * latent bug, it is the contract two callers need: single-user mode and the
   * membership-less break-glass path both reach `GET /org-trees` with no tenant
   * to scope to, so the parameter cannot simply be made required. But it means
   * `list({ organizationId: undefined, orgTreeIds })` — a caller who meant to
   * scope and passed a value that was `undefined` at runtime — is an
   * unrepresentable-in-review, cross-tenant read that type-checks. It is the same
   * shape this class of defect keeps returning in, and the reason the three
   * promote services' `instanceId` and `PageStateDeps.organizationId` were all
   * made REQUIRED.
   *
   * The durable fix is a discriminated option — `{ unscoped: true } | { organizationId: string }`
   * — which keeps both callers expressible while making the unsafe call impossible
   * to write by omission. Deliberately not done in the change that added this
   * parameter: it would have widened a security fix into a signature refactor.
   * Until then, EVERY new caller must be read as "does this path have a tenant,
   * and does it pass it?", because the compiler will not ask.
   */
  async list(
    opts: { organizationId?: string; orgTreeIds?: string[] } = {},
  ): Promise<OrgTreeSummary[]> {
    const where =
      opts.organizationId === undefined && opts.orgTreeIds === undefined
        ? undefined
        : {
            ...(opts.organizationId === undefined
              ? {}
              : { organizationId: opts.organizationId }),
            ...(opts.orgTreeIds === undefined ? {} : { id: { in: opts.orgTreeIds } }),
          };
    const rows = await this.prisma.orgTree.findMany({
      where,
      orderBy: { position: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      position: r.position,
      lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
    }));
  }

  async getWithEmployees(
    id: string,
    opts?: { includeSalary?: boolean },
  ): Promise<OrgTreeDto | null> {
    const tree = await this.prisma.orgTree.findUnique({
      where: { id },
      include: {
        employees: {
          include: { aliases: true },
          orderBy: [{ position: 'asc' }, { name: 'asc' }],
        },
      },
    });
    if (!tree) return null;
    const rankingByEmployee = computeTreeRanking(tree.employees);
    const employees: OrgEmployeeDto[] = tree.employees.map((e) =>
      toOrgEmployeeDto(e, e.aliases, !!opts?.includeSalary, rankingByEmployee.get(e.id) ?? null),
    );
    return {
      id: tree.id,
      name: tree.name,
      position: tree.position,
      lastSyncedAt: tree.lastSyncedAt ? tree.lastSyncedAt.toISOString() : null,
      employees,
    };
  }

  async importEmployees(treeId: string, rows: RawOrgRow[]): Promise<ImportResult> {
    const { employees, vacancies, rejectedRows } = normalizeOrgRows(rows);
    const { withManager, orphanWarnings } = resolveHierarchy(employees);

    let created = 0;
    let updated = 0;
    for (const [position, e] of withManager.entries()) {
      if (e.externalId) {
        const existing = await this.prisma.orgEmployee.findUnique({
          where: { orgTreeId_externalId: { orgTreeId: treeId, externalId: e.externalId } },
        });
        await this.prisma.orgEmployee.upsert({
          where: { orgTreeId_externalId: { orgTreeId: treeId, externalId: e.externalId } },
          create: {
            orgTreeId: treeId,
            externalId: e.externalId,
            name: e.name,
            role: e.role,
            email: e.email,
            managerExternalId: e.managerExternalId,
            isVacancy: e.isVacancy,
            position,
          },
          update: {
            name: e.name,
            role: e.role,
            email: e.email,
            managerExternalId: e.managerExternalId,
            isVacancy: e.isVacancy,
            position,
          },
        });
        if (existing) { updated += 1; } else { created += 1; }
      } else {
        await this.prisma.orgEmployee.create({
          data: {
            orgTreeId: treeId,
            name: e.name,
            role: e.role,
            email: e.email,
            managerExternalId: e.managerExternalId,
            isVacancy: e.isVacancy,
            position,
          },
        });
        created += 1;
      }
    }

    // Resolve managerId from managerExternalId within the tree
    const all = await this.prisma.orgEmployee.findMany({ where: { orgTreeId: treeId } });
    const byExternal = new Map(all.filter((e) => e.externalId).map((e) => [e.externalId as string, e.id]));
    for (const e of all) {
      const managerId = e.managerExternalId ? (byExternal.get(e.managerExternalId) ?? null) : null;
      if (managerId !== e.managerId) {
        await this.prisma.orgEmployee.update({ where: { id: e.id }, data: { managerId } });
      }
    }

    return { created, updated, vacancies, rejectedRows, orphanWarnings };
  }

  async addAlias(
    employeeId: string,
    input: { provider: string; kind: string; value: string },
  ): Promise<{ id: string }> {
    const row = await this.prisma.orgEmployeeAlias.create({
      data: { employeeId, provider: input.provider, kind: input.kind, value: input.value },
    });
    return { id: row.id };
  }

  async deleteAlias(aliasId: string): Promise<void> {
    await this.prisma.orgEmployeeAlias.delete({ where: { id: aliasId } });
  }

  async getEmployeeForActivity(
    id: string,
  ): Promise<{
    id: string;
    name: string;
    email: string | null;
    aliases: { provider: string; kind: string; value: string }[];
  } | null> {
    const e = await this.prisma.orgEmployee.findUnique({
      where: { id },
      include: { aliases: true },
    });
    if (!e) return null;
    return {
      id: e.id,
      name: e.name,
      email: e.email,
      aliases: e.aliases.map((a) => ({ provider: a.provider, kind: a.kind, value: a.value })),
    };
  }

  async getSyncStatus(treeId: string): Promise<SyncStatus> {
    const tree = await this.prisma.orgTree.findUnique({ where: { id: treeId } });
    const summary = (tree?.lastSyncSummary ?? null) as {
      matched?: number;
      total?: number;
      unmatched?: string[];
    } | null;
    return {
      state: 'idle',
      lastSyncedAt: tree?.lastSyncedAt ? tree.lastSyncedAt.toISOString() : null,
      matched: summary?.matched ?? 0,
      total: summary?.total ?? 0,
      unmatched: summary?.unmatched ?? [],
    };
  }

  /**
   * A `managerId` arriving from a request body has been gated by nothing — the
   * route policy checked the SUBJECT employee's (or the tree's) access, never
   * the manager's. A manager from another tree writes a parent pointer that
   * `moveEmployee`'s own cycle detection cannot even see, since that is scoped
   * to `orgTreeId`, and puts a row from a tree the caller may hold nothing on
   * into this tree's hierarchy. Refuse it — same rule as
   * `EmployeeBoardService.addExistingMembers`.
   */
  private async assertManagerInTree(
    orgTreeId: string,
    managerId: string | null | undefined,
  ): Promise<void> {
    if (!managerId) return;
    const manager = await this.prisma.orgEmployee.findUnique({
      where: { id: managerId },
      select: { orgTreeId: true },
    });
    if (!manager || manager.orgTreeId !== orgTreeId) throw new CrossTreeEmployeeError([managerId]);
  }

  async createEmployee(
    treeId: string,
    input: { name: string; role?: string | null; managerId?: string | null },
  ): Promise<{ id: string }> {
    await this.assertManagerInTree(treeId, input.managerId);
    const siblings = await this.prisma.orgEmployee.aggregate({
      where: { orgTreeId: treeId, managerId: input.managerId ?? null },
      _max: { position: true },
    });
    const row = await this.prisma.orgEmployee.create({
      data: {
        orgTreeId: treeId,
        name: input.name,
        role: input.role ?? null,
        managerId: input.managerId ?? null,
        position: (siblings._max.position ?? -1) + 1,
      },
    });
    return { id: row.id };
  }

  async updateEmployee(
    id: string,
    input: UpdateEmployeeProfileInput,
    opts: { canEditSalary: boolean },
  ): Promise<void> {
    const touchesSalary =
      input.salaryCurrent !== undefined || input.salaryCurrency !== undefined;
    if (touchesSalary && !opts.canEditSalary) {
      throw new OrgEmployeeForbiddenError();
    }
    const set = <K extends keyof UpdateEmployeeProfileInput>(key: K) =>
      input[key] !== undefined ? { [key]: input[key] } : {};
    await this.prisma.orgEmployee.update({
      where: { id },
      data: {
        ...set('name'),
        ...set('role'),
        ...set('email'),
        ...(input.employeeId !== undefined ? { employeeDisplayId: input.employeeId } : {}),
        ...set('businessTitle'),
        ...(input.hireDate !== undefined
          ? { hireDate: input.hireDate ? new Date(input.hireDate) : null }
          : {}),
        ...set('location'),
        ...set('employeeType'),
        ...set('timeType'),
        ...set('phone'),
        ...set('workAddress'),
        ...(opts.canEditSalary ? set('salaryCurrent') : {}),
        ...(opts.canEditSalary ? set('salaryCurrency') : {}),
      },
    });
  }

  async deleteEmployee(id: string): Promise<void> {
    const emp = await this.prisma.orgEmployee.findUnique({ where: { id } });
    if (!emp) return;
    await this.prisma.$transaction([
      this.prisma.orgEmployee.updateMany({
        where: { managerId: id },
        data: { managerId: emp.managerId },
      }),
      this.prisma.orgEmployee.delete({ where: { id } }),
    ]);
  }

  async moveEmployee(id: string, input: { managerId: string | null; position: number }): Promise<void> {
    const emp = await this.prisma.orgEmployee.findUnique({ where: { id } });
    if (!emp) return;
    await this.assertManagerInTree(emp.orgTreeId, input.managerId);
    const all = await this.prisma.orgEmployee.findMany({
      where: { orgTreeId: emp.orgTreeId },
      select: { id: true, managerId: true },
    });
    if (wouldCreateCycle(all, id, input.managerId)) {
      throw new OrgTreeCycleError();
    }
    const siblings = (
      await this.prisma.orgEmployee.findMany({
        where: { orgTreeId: emp.orgTreeId, managerId: input.managerId },
        orderBy: { position: 'asc' },
      })
    ).filter((s) => s.id !== id);
    const ordered = [
      ...siblings.slice(0, input.position),
      { id, isMoved: true },
      ...siblings.slice(input.position),
    ];
    await this.prisma.$transaction(
      ordered.map((s, i) =>
        this.prisma.orgEmployee.update({
          where: { id: s.id },
          data: (s as { id: string; isMoved?: boolean }).isMoved
            ? { managerId: input.managerId, position: i }
            : { position: i },
        }),
      ),
    );
  }

  async delete(id: string): Promise<void> {
    await this.prisma.orgTree.delete({ where: { id } });
  }
}
