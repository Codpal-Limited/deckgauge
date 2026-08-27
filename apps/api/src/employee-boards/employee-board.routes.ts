import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  CreateEmployeeBoardSchema,
  RenameEmployeeBoardSchema,
  SetEmployeeBoardPersonalSchema,
  CreateEmployeeGroupSchema,
  UpdateEmployeeGroupSchema,
  ReorderEmployeeGroupsSchema,
  AddExistingMembersSchema,
  AddNewEmployeeSchema,
  MoveMemberSchema,
  SetManagerSchema,
  EmployeeBoardColumnConfigSchema,
  CreateEmployeeColumnSchema,
  UpdateEmployeeColumnSchema,
  SetEmployeeFieldValueSchema,
} from '@deckgauge/shared';
import type { EmployeeBoardService } from './employee-board.service.js';
import { OrgTreeCycleError, CrossTreeEmployeeError } from '../org-trees/org-tree.service.js';
import { orgTree, employeeBoard, employeeBoardInTree, any, ORG_ADMIN, VIA_MEMBER, viaOrgEntity, fromParam, fromBodyField } from '../auth/policy.js';

export interface EmployeeBoardRoutesDeps {
  serviceFactory: () => EmployeeBoardService;
}

const uuid = z.string().uuid();
const badId = (reply: FastifyReply) => reply.code(400).send({ error: 'bad id' });

/**
 * Phase C: these routes decide on the BOARD, not the tree it lives in (design
 * D12). `employeeBoard(...)` with no source reads `:boardId` directly; the
 * three sources below walk the same `ORG_ENTITY_PATH` hops the old
 * `viaOrgEntity` sources did, but answer with a board id rather than a tree id.
 *
 * `VIA_MEMBER` is exported from the policy module because the hop it names is
 * the one the spec calls out (§7.3); the group and column hops are local
 * because nothing else needs them.
 */
const EB_VIA_GROUP = { model: 'employeeGroup' as const, ids: fromParam('groupId') };
const EB_VIA_COLUMN = { model: 'employeeColumn' as const, ids: fromParam('columnId') };

export function employeeBoardRoutes(deps: EmployeeBoardRoutesDeps) {
  const service = deps.serviceFactory();
  return async function plugin(app: FastifyInstance) {
    // No board/tree id lives on this request other than :treeId itself, which
    // is already covered by resolveOrgTreeIds's no-source default (orgTreeId,
    // then treeId, then id) — no explicit source needed.
    /**
     * The same two ways in as the shell (design D14), and for the same reason.
     *
     * The spec's §7.3 leaves this route on `orgTree(VIEWER)` — "listing and
     * creating are tree-level operations, and the list is filtered per-caller
     * instead of gated". The filtering half is right, the gate is not: a
     * board-only grantee passes `GET /org-trees/:id` through `any(...)` and was
     * then 403'd HERE, so they reached the shell and still could not see the
     * board tab that is the entire point of per-board sharing. Found by the
     * phase C end-to-end pass.
     *
     * Admitting them exposes nothing: `listVisibleForUser` returns only boards
     * they hold effective access on, so a caller with no reachable board gets
     * an empty array rather than a 403 — which is the honest answer to "which
     * boards in this tree may I see?".
     */
    app.get<{ Params: { treeId: string } }>('/org-trees/:treeId/employee-boards', { config: { policy: any(orgTree('VIEWER'), employeeBoardInTree('VIEWER')) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.treeId).success) return badId(reply);
      // The gate says "you may ask about this tree"; the handler decides what
      // comes back. Filtering here rather than gating is what lets a board-only
      // grantee reach exactly their board (design D12/D14).
      return service.listVisibleForUser(
        req.params.treeId,
        req.user?.id ?? '',
        req.membership ?? null,
      );
    });

    app.post<{ Params: { treeId: string } }>('/org-trees/:treeId/employee-boards', { config: { policy: orgTree('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.treeId).success) return badId(reply);
      const body = CreateEmployeeBoardSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      // The creator becomes OWNER atomically. `req.user?.id` rather than `!`:
      // single-user mode resolves no user, and the board is still creatable then.
      return reply
        .code(201)
        .send(await service.createBoard(req.params.treeId, body.data, req.user?.id));
    });

    app.get<{ Params: { boardId: string } }>('/employee-boards/:boardId', { config: { policy: employeeBoard('VIEWER') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
      // The policy above only gates *reaching* the board; salary visibility is an
      // independent, second question asked once inside it. Deliberately NOT folded
      // into the policy — it is not a level in the role ladder.
      //
      // Now a GRANT rather than `req.isAdmin` alone: `canViewSalary` answers
      // "isAdmin OR an explicit grant on this board's tree", from the one resolver
      // both salary gates share.
      const includeSalary = await service.canViewSalary(
        req.params.boardId,
        req.user?.id ?? null,
        req.isAdmin ?? false,
      );
      const board = await service.getBoard(req.params.boardId, { includeSalary });
      if (!board) return reply.code(404).send({ error: 'not found' });
      return board;
    });

    app.patch<{ Params: { boardId: string } }>('/employee-boards/:boardId', { config: { policy: employeeBoard('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
      const body = RenameEmployeeBoardSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      await service.renameBoard(req.params.boardId, body.data.name);
      return reply.code(204).send();
    });

    /**
     * Marking a board personal is its OWN route, gated on OWNER, rather than a
     * field on the rename PATCH above: renaming is an editing action (EDITOR),
     * while deciding who may READ a board is not. Keeping them separate keeps
     * both policies declarative instead of hand-rolling a role check in a
     * handler.
     */
    app.put<{ Params: { boardId: string } }>(
      '/employee-boards/:boardId/personal',
      { config: { policy: employeeBoard('OWNER') } },
      async (req, reply) => {
        if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
        const body = SetEmployeeBoardPersonalSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        await service.setPersonal(req.params.boardId, body.data.isPersonal);
        return reply.code(204).send();
      },
    );

    /**
     * OWNER, not EDITOR — matching DELETE /org-trees/:id: destroying a board's
     * layout is not an editing action.
     *
     * `any(..., ORG_ADMIN)` because a PERSONAL board is exempt from the org-ADMIN
     * floor, and without this an admin could neither read NOR delete one. Design
     * D6 draws the line at reading: an org admin can always find, list and
     * destroy, because content nobody can clean up is a worse problem than
     * content an admin cannot read. On an ordinary board this arm adds nothing —
     * the floor already made them an OWNER.
     */
    app.delete<{ Params: { boardId: string } }>('/employee-boards/:boardId', { config: { policy: any(employeeBoard('OWNER'), ORG_ADMIN) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
      await service.deleteBoard(req.params.boardId);
      return reply.code(204).send();
    });

    app.post<{ Params: { boardId: string } }>('/employee-boards/:boardId/groups', { config: { policy: employeeBoard('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
      const body = CreateEmployeeGroupSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      return service.createGroup(req.params.boardId, body.data);
    });

    app.patch<{ Params: { groupId: string } }>(
      '/employee-groups/:groupId',
      { config: { policy: employeeBoard('EDITOR', EB_VIA_GROUP) } },
      async (req, reply) => {
        if (!uuid.safeParse(req.params.groupId).success) return badId(reply);
        const body = UpdateEmployeeGroupSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        await service.updateGroup(req.params.groupId, body.data);
        return reply.code(204).send();
      },
    );

    app.delete<{ Params: { groupId: string } }>(
      '/employee-groups/:groupId',
      { config: { policy: employeeBoard('EDITOR', EB_VIA_GROUP) } },
      async (req, reply) => {
        if (!uuid.safeParse(req.params.groupId).success) return badId(reply);
        await service.deleteGroup(req.params.groupId);
        return reply.code(204).send();
      },
    );

    app.patch<{ Params: { boardId: string } }>('/employee-boards/:boardId/groups/reorder', { config: { policy: employeeBoard('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
      const body = ReorderEmployeeGroupsSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      // `:boardId` — the id the policy gated — must be threaded through:
      // the body carries only group ids, which nothing has checked.
      await service.reorderGroups(req.params.boardId, body.data.order);
      return reply.code(204).send();
    });

    // The policy gates `:boardId`. `orgEmployeeIds` is body-supplied and gated
    // by nothing, so the service confirms every id belongs to this board's own
    // org tree and refuses the whole request otherwise — 403, not 400: the
    // request is well-formed, the caller simply may not reach those rows.
    app.post<{ Params: { boardId: string } }>('/employee-boards/:boardId/members', { config: { policy: employeeBoard('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
      const body = AddExistingMembersSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      try {
        await service.addExistingMembers(req.params.boardId, body.data.orgEmployeeIds);
      } catch (err) {
        if (err instanceof CrossTreeEmployeeError) {
          return reply.code(403).send({ error: err.message, orgEmployeeIds: err.orgEmployeeIds });
        }
        throw err;
      }
      return reply.code(204).send();
    });

    app.post<{ Params: { boardId: string } }>('/employee-boards/:boardId/employees', { config: { policy: employeeBoard('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
      const body = AddNewEmployeeSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      try {
        // `managerId` is body-supplied; the tree it must live in is the
        // board's, which is what the policy gated.
        return await service.addNewEmployee(req.params.boardId, body.data);
      } catch (err) {
        if (err instanceof CrossTreeEmployeeError) {
          return reply.code(403).send({ error: err.message, orgEmployeeIds: err.orgEmployeeIds });
        }
        throw err;
      }
    });

    app.patch<{ Params: { memberId: string } }>('/employee-board-members/:memberId/move', { config: { policy: employeeBoard('EDITOR', VIA_MEMBER) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.memberId).success) return badId(reply);
      const body = MoveMemberSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      await service.moveMember(req.params.memberId, body.data);
      return reply.code(204).send();
    });

    app.delete<{ Params: { memberId: string } }>('/employee-board-members/:memberId', { config: { policy: employeeBoard('EDITOR', VIA_MEMBER) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.memberId).success) return badId(reply);
      await service.removeMember(req.params.memberId);
      return reply.code(204).send();
    });

    app.patch<{ Params: { boardId: string } }>('/employee-boards/:boardId/columns', { config: { policy: employeeBoard('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
      const body = EmployeeBoardColumnConfigSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      await service.setColumnConfig(req.params.boardId, body.data);
      return reply.code(204).send();
    });

    // Mandatory addition (not in Task 6's brief table — the plan wrongly
    // assigned this route to Task 5, whose scope forbade touching this file,
    // so it was left on AUTHENTICATED until now). `:employeeId`, NOT `:id` —
    // fromParam('id') would resolve nothing here and silently 403 every
    // caller.
    app.patch<{ Params: { employeeId: string } }>(
      '/org-employees/:employeeId/manager',
      { config: { policy: orgTree('EDITOR', viaOrgEntity('orgEmployee', fromParam('employeeId'))) } },
      async (req, reply) => {
        if (!uuid.safeParse(req.params.employeeId).success) return badId(reply);
        const body = SetManagerSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        try {
          // The policy gated `:employeeId` only — `managerId` comes from the
          // body and is gated by nothing, so the service refuses one that
          // lives in a different tree.
          await service.setManager(req.params.employeeId, body.data.managerId);
          return reply.code(204).send();
        } catch (err) {
          if (err instanceof OrgTreeCycleError) return reply.code(409).send({ error: 'cycle' });
          if (err instanceof CrossTreeEmployeeError) {
            return reply.code(403).send({ error: err.message, orgEmployeeIds: err.orgEmployeeIds });
          }
          throw err;
        }
      },
    );

    app.post<{ Params: { boardId: string } }>('/employee-boards/:boardId/custom-columns', { config: { policy: employeeBoard('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
      const body = CreateEmployeeColumnSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      return service.createColumn(req.params.boardId, body.data);
    });

    app.patch<{ Params: { columnId: string } }>(
      '/employee-columns/:columnId',
      { config: { policy: employeeBoard('EDITOR', EB_VIA_COLUMN) } },
      async (req, reply) => {
        if (!uuid.safeParse(req.params.columnId).success) return badId(reply);
        const body = UpdateEmployeeColumnSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        await service.updateColumn(req.params.columnId, body.data);
        return reply.code(204).send();
      },
    );

    app.delete<{ Params: { columnId: string } }>(
      '/employee-columns/:columnId',
      { config: { policy: employeeBoard('EDITOR', EB_VIA_COLUMN) } },
      async (req, reply) => {
        if (!uuid.safeParse(req.params.columnId).success) return badId(reply);
        await service.deleteColumn(req.params.columnId);
        return reply.code(204).send();
      },
    );

    // Both arms are required: checking only the column would let a caller
    // write a value onto an employee in a tree they cannot see, and checking
    // only the employee would let them write through a column they cannot
    // see. resolveOrgTreeIds requires EDITOR on every resolved tree, so a
    // caller must hold it on both.
    app.put(
      '/employee-field-values',
      {
        config: {
          policy: orgTree('EDITOR', [
            viaOrgEntity('employeeColumn', fromBodyField('employeeColumnId')),
            viaOrgEntity('orgEmployee', fromBodyField('orgEmployeeId')),
          ]),
        },
      },
      async (req, reply) => {
        const body = SetEmployeeFieldValueSchema.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
        await service.setFieldValue(body.data.employeeColumnId, body.data.orgEmployeeId, body.data.value);
        return reply.code(204).send();
      },
    );
  };
}
