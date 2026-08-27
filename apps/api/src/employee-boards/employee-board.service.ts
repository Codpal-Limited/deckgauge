import type { PrismaClient, Prisma } from '@deckgauge/db';
import {
  collectSubtreeEmployeeIds,
  EmployeeBoardColumnConfigSchema,
  type EmployeeBoardColumnConfig,
  type EmployeeBoardSummaryDto,
  type EmployeeBoardDetailDto,
  type EmployeeColumnDto,
} from '@deckgauge/shared';
import { toOrgEmployeeDto } from '../org-trees/org-employee-dto.js';
import { effectiveBoardRole } from '../authz/policy.js';
import type { OrgRoleValue } from '@deckgauge/shared';
import { OrgTreeService, computeTreeRanking, CrossTreeEmployeeError } from '../org-trees/org-tree.service.js';
import { canViewSalaryForBoard } from '../org-trees/salary-visibility.js';

export class EmployeeBoardService {
  private readonly orgService: OrgTreeService;

  constructor(private readonly prisma: PrismaClient) {
    this.orgService = new OrgTreeService(prisma);
  }

  async defaultGroupId(boardId: string): Promise<string> {
    const g = await this.prisma.employeeGroup.findFirst({
      where: { employeeBoardId: boardId },
      orderBy: { position: 'asc' },
    });
    if (!g) throw new Error('board has no groups');
    return g.id;
  }

  async createGroup(
    boardId: string,
    input: { name: string; color?: string }
  ): Promise<{ id: string }> {
    const max = await this.prisma.employeeGroup.aggregate({
      where: { employeeBoardId: boardId },
      _max: { position: true },
    });
    const g = await this.prisma.employeeGroup.create({
      data: {
        employeeBoardId: boardId,
        name: input.name,
        ...(input.color ? { color: input.color } : {}),
        position: (max._max.position ?? -1) + 1,
      },
    });
    return { id: g.id };
  }

  async updateGroup(groupId: string, input: { name?: string; color?: string }): Promise<void> {
    await this.prisma.employeeGroup.update({
      where: { id: groupId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
      },
    });
  }

  async deleteGroup(groupId: string): Promise<void> {
    const group = await this.prisma.employeeGroup.findUnique({ where: { id: groupId } });
    if (!group) return;

    // Find the destination group: lowest-position group on the same board that isn't this one
    let dest = await this.prisma.employeeGroup.findFirst({
      where: { employeeBoardId: group.employeeBoardId, id: { not: groupId } },
      orderBy: { position: 'asc' },
    });

    // No other group exists — create a fresh Ungrouped group
    if (!dest) {
      dest = await this.prisma.employeeGroup.create({
        data: { employeeBoardId: group.employeeBoardId, name: 'Ungrouped', position: 0 },
      });
    }

    // Reassign all members from the deleted group to the destination group,
    // appending after the destination's current max position
    const destMax = await this.prisma.employeeBoardMember.aggregate({
      where: { employeeGroupId: dest.id },
      _max: { position: true },
    });
    const basePos = (destMax._max.position ?? -1) + 1;

    const members = await this.prisma.employeeBoardMember.findMany({
      where: { employeeGroupId: groupId },
      orderBy: { position: 'asc' },
    });

    await this.prisma.$transaction([
      ...members.map((m, i) =>
        this.prisma.employeeBoardMember.update({
          where: { id: m.id },
          data: { employeeGroupId: dest!.id, position: basePos + i },
        })
      ),
      this.prisma.employeeGroup.delete({ where: { id: groupId } }),
    ]);
  }

  /**
   * `boardId` is the id the route policy actually gated; the group ids come
   * from the body and are gated by nothing. Every update is therefore scoped
   * to `employeeBoardId: boardId` — a group id belonging to some other board
   * matches zero rows instead of being repositioned, so no write can escape
   * the board the caller was authorized against.
   *
   * `updateMany`, not `update`, precisely so a foreign id is a no-op rather
   * than a P2025 mid-transaction. Same silent-guard shape as `moveMember`'s
   * `targetGroup.employeeBoardId !== member.employeeBoardId` check below:
   * reordering is idempotent positional data that leaks nothing, so skipping
   * an out-of-scope id is enough — unlike `addExistingMembers`, where the
   * ids being refused are what the request is FOR.
   */
  async reorderGroups(boardId: string, order: { id: string; position: number }[]): Promise<void> {
    await this.prisma.$transaction(
      order.map((o) =>
        this.prisma.employeeGroup.updateMany({
          where: { id: o.id, employeeBoardId: boardId },
          data: { position: o.position },
        })
      )
    );
  }

  /**
   * The route policy gates `:boardId` only — `orgEmployeeIds` comes from the
   * body and is gated by nothing. Confirm every named employee lives in this
   * board's own org tree before creating membership rows, or a caller who owns
   * a tree of their own can attach employees from a tree they hold nothing on
   * and then read their full profiles back through `GET
   * /employee-boards/:boardId`. Refuses the whole request rather than trimming
   * — see `CrossTreeEmployeeError`.
   */
  async addExistingMembers(boardId: string, orgEmployeeIds: string[]): Promise<void> {
    const board = await this.prisma.employeeBoard.findUnique({
      where: { id: boardId },
      select: { orgTreeId: true },
    });
    if (!board) throw new Error('board not found');

    const requested = [...new Set(orgEmployeeIds)];
    const inTree = await this.prisma.orgEmployee.findMany({
      where: { id: { in: requested }, orgTreeId: board.orgTreeId },
      select: { id: true },
    });
    const allowed = new Set(inTree.map((e) => e.id));
    const foreign = requested.filter((id) => !allowed.has(id));
    if (foreign.length > 0) throw new CrossTreeEmployeeError(foreign);

    const groupId = await this.defaultGroupId(boardId);
    const max = await this.prisma.employeeBoardMember.aggregate({
      where: { employeeGroupId: groupId },
      _max: { position: true },
    });
    let pos = (max._max.position ?? -1) + 1;
    await this.prisma.employeeBoardMember.createMany({
      data: orgEmployeeIds.map((orgEmployeeId) => ({
        employeeBoardId: boardId,
        orgEmployeeId,
        employeeGroupId: groupId,
        position: pos++,
      })),
      skipDuplicates: true,
    });
  }

  async addNewEmployee(
    boardId: string,
    input: { name: string; managerId: string | null }
  ): Promise<{ employeeId: string; memberId: string }> {
    const board = await this.prisma.employeeBoard.findUnique({
      where: { id: boardId },
      select: { orgTreeId: true },
    });
    if (!board) throw new Error('board not found');
    const groupId = await this.defaultGroupId(boardId);
    const created = await this.orgService.createEmployee(board.orgTreeId, {
      name: input.name,
      managerId: input.managerId,
    });
    const max = await this.prisma.employeeBoardMember.aggregate({
      where: { employeeGroupId: groupId },
      _max: { position: true },
    });
    const member = await this.prisma.employeeBoardMember.create({
      data: {
        employeeBoardId: boardId,
        orgEmployeeId: created.id,
        employeeGroupId: groupId,
        position: (max._max.position ?? -1) + 1,
      },
    });
    return { employeeId: created.id, memberId: member.id };
  }

  async moveMember(
    memberId: string,
    input: { employeeGroupId: string; position: number }
  ): Promise<void> {
    const member = await this.prisma.employeeBoardMember.findUnique({ where: { id: memberId } });
    if (!member) return;

    // Guard: target group must belong to the same board
    const targetGroup = await this.prisma.employeeGroup.findUnique({
      where: { id: input.employeeGroupId },
    });
    if (!targetGroup || targetGroup.employeeBoardId !== member.employeeBoardId) return;

    const siblings = (
      await this.prisma.employeeBoardMember.findMany({
        where: { employeeGroupId: input.employeeGroupId },
        orderBy: { position: 'asc' },
      })
    ).filter((s) => s.id !== memberId);
    const ordered = [
      ...siblings.slice(0, input.position),
      { id: memberId, moved: true as const },
      ...siblings.slice(input.position),
    ];
    await this.prisma.$transaction(
      ordered.map((s, i) =>
        this.prisma.employeeBoardMember.update({
          where: { id: s.id },
          data:
            'moved' in s
              ? { employeeGroupId: input.employeeGroupId, position: i }
              : { position: i },
        })
      )
    );
  }

  async removeMember(memberId: string): Promise<void> {
    await this.prisma.employeeBoardMember.deleteMany({ where: { id: memberId } });
  }

  async setManager(employeeId: string, managerId: string | null): Promise<void> {
    // moveEmployee re-sequences siblings; a large position reliably appends last.
    await this.orgService.moveEmployee(employeeId, {
      managerId,
      position: Number.MAX_SAFE_INTEGER,
    });
  }

  /**
   * `creatorUserId` is OPTIONAL for the same reason `OrgTreeService.create`'s third
   * parameter is: single-user mode bypasses every policy and never populates a
   * user, and the board must still be creatable then — just with no owner row.
   *
   * When present, the creator is stamped OWNER **in the same transaction as the
   * board**. That is R5.5's rule for project boards, finally applied here: before
   * this, `createBoard` wrote no `EmployeeBoardAccess` row at all, so sharing
   * phase C's grant table started at zero owners and a creator held no recorded
   * relationship to what they made. It stayed invisible only because two
   * implicit-owner rules (the org-ADMIN floor and D12's tree-OWNER rule) always
   * admitted somebody — and those are exactly what a PERSONAL board is exempt
   * from, so this grant is that feature's precondition.
   */
  async createBoard(
    orgTreeId: string,
    input: { name: string; scopeEmployeeId: string | null; isPersonal?: boolean },
    creatorUserId?: string
  ): Promise<{ id: string }> {
    const employees = await this.prisma.orgEmployee.findMany({
      where: { orgTreeId },
      select: { id: true, name: true, managerId: true, isVacancy: true },
    });
    const ids = collectSubtreeEmployeeIds(employees, input.scopeEmployeeId);
    const byId = new Map(employees.map((e) => [e.id, e]));
    const ordered = ids.map((id) => byId.get(id)!).sort((a, b) => a.name.localeCompare(b.name));

    const maxPos = await this.prisma.employeeBoard.aggregate({
      where: { orgTreeId },
      _max: { position: true },
    });

    // One transaction, so a failed owner grant cannot leave an orphan board with
    // nobody attached to it — the very state this grant exists to prevent.
    return this.prisma.$transaction(async (tx) => {
      const board = await tx.employeeBoard.create({
        data: {
          orgTreeId,
          name: input.name,
          scopeEmployeeId: input.scopeEmployeeId,
          isPersonal: input.isPersonal ?? false,
          position: (maxPos._max.position ?? -1) + 1,
          groups: { create: { name: 'Ungrouped', position: 0 } },
        },
        include: { groups: true },
      });
      const ungrouped = board.groups[0]!;

      if (ordered.length > 0) {
        await tx.employeeBoardMember.createMany({
          data: ordered.map((e, i) => ({
            employeeBoardId: board.id,
            orgEmployeeId: e.id,
            employeeGroupId: ungrouped.id,
            position: i,
          })),
        });
      }

      if (creatorUserId) {
        await tx.employeeBoardAccess.create({
          data: { employeeBoardId: board.id, userId: creatorUserId, role: 'OWNER' },
        });
      }

      return { id: board.id };
    });
  }

  async listBoards(orgTreeId: string): Promise<EmployeeBoardSummaryDto[]> {
    const rows = await this.prisma.employeeBoard.findMany({
      where: { orgTreeId },
      orderBy: { position: 'asc' },
    });
    return rows.map((b) => ({
      id: b.id,
      orgTreeId: b.orgTreeId,
      name: b.name,
      scopeEmployeeId: b.scopeEmployeeId,
      position: b.position,
    }));
  }

  /**
   * The boards in `orgTreeId` this caller may see (design D12).
   *
   * `GET /org-trees/:treeId/employee-boards` stays gated on `orgTree(VIEWER)`
   * because the set to return IS the answer — the gate says "you may ask about
   * this tree", and this decides what comes back. A board-only grantee reaches
   * it through D14's `any(...)` on the shell and sees exactly their board.
   *
   * One query, not N: each row carries the caller's own grant and their grant on
   * the parent tree, and the ceiling is applied in memory. An org-tree OWNER
   * sees every board with no per-board grant — D12's implicit ownership, which
   * is why owners never have to grant themselves access to boards they made.
   */
  async listVisibleForUser(
    orgTreeId: string,
    userId: string,
    membership: { organizationId: string; role: OrgRoleValue } | null,
  ): Promise<EmployeeBoardSummaryDto[]> {
    if (!userId) return [];
    const rows = await this.prisma.employeeBoard.findMany({
      where: { orgTreeId },
      orderBy: { position: 'asc' },
      include: {
        access: { where: { userId }, select: { role: true } },
        orgTree: { select: { access: { where: { userId }, select: { role: true } } } },
      },
    });

    return rows
      .filter((row) => {
        const treeGrant = row.orgTree.access[0]?.role ?? null;
        const grant = treeGrant === 'OWNER' ? 'OWNER' : (row.access[0]?.role ?? null);
        // No membership is the break-glass path: no ceiling to apply, so the
        // raw grant decides — mirroring the policy layer's own null-membership
        // branch rather than inventing a second rule.
        if (!membership) return grant !== null;
        return effectiveBoardRole(membership.role, grant) !== null;
      })
      .map((b) => ({
        id: b.id,
        orgTreeId: b.orgTreeId,
        name: b.name,
        scopeEmployeeId: b.scopeEmployeeId,
        position: b.position,
      }));
  }

  async getBoard(
    boardId: string,
    opts: { includeSalary: boolean }
  ): Promise<EmployeeBoardDetailDto | null> {
    const board = await this.prisma.employeeBoard.findUnique({
      where: { id: boardId },
      include: {
        groups: {
          orderBy: { position: 'asc' },
          include: {
            members: {
              orderBy: { position: 'asc' },
              include: { employee: { include: { aliases: true } } },
            },
          },
        },
        columns: {
          orderBy: { position: 'asc' },
          include: { fieldValues: true },
        },
      },
    });
    if (!board) return null;
    // Ranking is tree-relative: compute the leaderboard across every employee in the
    // board's org tree (not just the board's members) so a member's rank/tier matches
    // exactly what the org chart shows. Board membership is an arbitrary subset and must
    // not change the min-max normalization or totalRanked.
    const treeEmployees = await this.prisma.orgEmployee.findMany({
      where: { orgTreeId: board.orgTreeId },
      select: {
        id: true,
        isVacancy: true,
        departedAt: true,
        matched: true,
        statsJson: true,
      },
    });
    const rankingByEmployee = computeTreeRanking(treeEmployees);
    const parsedConfig = EmployeeBoardColumnConfigSchema.safeParse(board.columnConfig);
    const columnConfig = parsedConfig.success ? parsedConfig.data : null;
    const columns: EmployeeColumnDto[] = board.columns.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type as EmployeeColumnDto['type'],
      position: c.position,
      config: (c.config as Record<string, unknown> | null) ?? null,
    }));
    const valuesByEmployee = new Map<string, Record<string, string>>();
    for (const c of board.columns) {
      for (const fv of c.fieldValues) {
        const rec = valuesByEmployee.get(fv.orgEmployeeId) ?? {};
        rec[c.id] = fv.value;
        valuesByEmployee.set(fv.orgEmployeeId, rec);
      }
    }
    return {
      id: board.id,
      orgTreeId: board.orgTreeId,
      name: board.name,
      scopeEmployeeId: board.scopeEmployeeId,
      position: board.position,
      columnConfig,
      columns,
      groups: board.groups.map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color,
        position: g.position,
        members: g.members.map((m) => ({
          id: m.id,
          position: m.position,
          employee: toOrgEmployeeDto(
            m.employee,
            m.employee.aliases,
            opts.includeSalary,
            rankingByEmployee.get(m.orgEmployeeId) ?? null
          ),
          fieldValues: valuesByEmployee.get(m.orgEmployeeId) ?? {},
        })),
      })),
    };
  }

  async createColumn(
    boardId: string,
    input: { name: string; type: string; config?: Record<string, unknown> }
  ): Promise<{ id: string }> {
    const max = await this.prisma.employeeColumn.aggregate({
      where: { employeeBoardId: boardId },
      _max: { position: true },
    });
    const col = await this.prisma.employeeColumn.create({
      data: {
        employeeBoardId: boardId,
        name: input.name,
        type: input.type,
        config: input.config as Prisma.InputJsonValue | undefined,
        position: (max._max.position ?? -1) + 1,
      },
    });
    return { id: col.id };
  }

  async updateColumn(
    columnId: string,
    input: { name?: string; config?: Record<string, unknown> }
  ): Promise<void> {
    await this.prisma.employeeColumn.update({
      where: { id: columnId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.config !== undefined ? { config: input.config as Prisma.InputJsonValue } : {}),
      },
    });
  }

  async deleteColumn(columnId: string): Promise<void> {
    await this.prisma.employeeColumn.deleteMany({ where: { id: columnId } });
  }

  async setFieldValue(
    employeeColumnId: string,
    orgEmployeeId: string,
    value: string
  ): Promise<void> {
    await this.prisma.employeeFieldValue.upsert({
      where: { employeeColumnId_orgEmployeeId: { employeeColumnId, orgEmployeeId } },
      create: { employeeColumnId, orgEmployeeId, value },
      update: { value },
    });
  }

  async setColumnConfig(boardId: string, config: EmployeeBoardColumnConfig): Promise<void> {
    await this.prisma.employeeBoard.update({
      where: { id: boardId },
      data: { columnConfig: config },
    });
  }

  async renameBoard(boardId: string, name: string): Promise<void> {
    await this.prisma.employeeBoard.update({ where: { id: boardId }, data: { name } });
  }

  async setPersonal(boardId: string, isPersonal: boolean): Promise<void> {
    await this.prisma.employeeBoard.update({ where: { id: boardId }, data: { isPersonal } });
  }

  /**
   * Delegates to the shared resolver rather than deciding here. A thin passthrough
   * on purpose: this route's deps carry no PrismaClient, and adding one just to
   * ask a question the service can already ask would change every construction
   * site for no gain. The RULE stays in one place either way.
   */
  async canViewSalary(
    boardId: string,
    userId: string | null,
    isAdmin: boolean,
  ): Promise<boolean> {
    return canViewSalaryForBoard(this.prisma, userId, boardId, isAdmin);
  }

  async deleteBoard(boardId: string): Promise<void> {
    await this.prisma.employeeBoard.delete({ where: { id: boardId } });
  }
}
