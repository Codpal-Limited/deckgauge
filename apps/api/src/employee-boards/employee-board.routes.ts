import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  CreateEmployeeBoardSchema,
  RenameEmployeeBoardSchema,
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
import { orgTree, viaOrgEntity, fromParam, fromBodyField } from '../auth/policy.js';

export interface EmployeeBoardRoutesDeps {
  serviceFactory: () => EmployeeBoardService;
}

const uuid = z.string().uuid();
const badId = (reply: FastifyReply) => reply.code(400).send({ error: 'bad id' });

const VIA_EB = viaOrgEntity('employeeBoard', fromParam('boardId'));
const VIA_EB_MEMBER = viaOrgEntity('employeeBoardMember', fromParam('memberId'));

export function employeeBoardRoutes(deps: EmployeeBoardRoutesDeps) {
  const service = deps.serviceFactory();
  return async function plugin(app: FastifyInstance) {
    // No board/tree id lives on this request other than :treeId itself, which
    // is already covered by resolveOrgTreeIds's no-source default (orgTreeId,
    // then treeId, then id) — no explicit source needed.
    app.get<{ Params: { treeId: string } }>('/org-trees/:treeId/employee-boards', { config: { policy: orgTree('VIEWER') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.treeId).success) return badId(reply);
      return service.listBoards(req.params.treeId);
    });

    app.post<{ Params: { treeId: string } }>('/org-trees/:treeId/employee-boards', { config: { policy: orgTree('EDITOR') } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.treeId).success) return badId(reply);
      const body = CreateEmployeeBoardSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      return reply.code(201).send(await service.createBoard(req.params.treeId, body.data));
    });

    app.get<{ Params: { boardId: string } }>('/employee-boards/:boardId', { config: { policy: orgTree('VIEWER', VIA_EB) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
      // orgTree(VIEWER) above only gates *reaching* the board; `isAdmin` is an
      // independent, second check on whether salary is visible once inside it.
      // Leave this exactly as it is — do not fold it into the policy.
      const board = await service.getBoard(req.params.boardId, { includeSalary: req.isAdmin ?? false });
      if (!board) return reply.code(404).send({ error: 'not found' });
      return board;
    });

    app.patch<{ Params: { boardId: string } }>('/employee-boards/:boardId', { config: { policy: orgTree('EDITOR', VIA_EB) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
      const body = RenameEmployeeBoardSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      await service.renameBoard(req.params.boardId, body.data.name);
      return reply.code(204).send();
    });

    // OWNER, not EDITOR — matching DELETE /org-trees/:id: destroying a board's
    // layout is not an editing action.
    app.delete<{ Params: { boardId: string } }>('/employee-boards/:boardId', { config: { policy: orgTree('OWNER', VIA_EB) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
      await service.deleteBoard(req.params.boardId);
      return reply.code(204).send();
    });

    app.post<{ Params: { boardId: string } }>('/employee-boards/:boardId/groups', { config: { policy: orgTree('EDITOR', VIA_EB) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
      const body = CreateEmployeeGroupSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      return service.createGroup(req.params.boardId, body.data);
    });

    app.patch<{ Params: { groupId: string } }>(
      '/employee-groups/:groupId',
      { config: { policy: orgTree('EDITOR', viaOrgEntity('employeeGroup', fromParam('groupId'))) } },
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
      { config: { policy: orgTree('EDITOR', viaOrgEntity('employeeGroup', fromParam('groupId'))) } },
      async (req, reply) => {
        if (!uuid.safeParse(req.params.groupId).success) return badId(reply);
        await service.deleteGroup(req.params.groupId);
        return reply.code(204).send();
      },
    );

    app.patch<{ Params: { boardId: string } }>('/employee-boards/:boardId/groups/reorder', { config: { policy: orgTree('EDITOR', VIA_EB) } }, async (req, reply) => {
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
    app.post<{ Params: { boardId: string } }>('/employee-boards/:boardId/members', { config: { policy: orgTree('EDITOR', VIA_EB) } }, async (req, reply) => {
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

    app.post<{ Params: { boardId: string } }>('/employee-boards/:boardId/employees', { config: { policy: orgTree('EDITOR', VIA_EB) } }, async (req, reply) => {
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

    app.patch<{ Params: { memberId: string } }>('/employee-board-members/:memberId/move', { config: { policy: orgTree('EDITOR', VIA_EB_MEMBER) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.memberId).success) return badId(reply);
      const body = MoveMemberSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      await service.moveMember(req.params.memberId, body.data);
      return reply.code(204).send();
    });

    app.delete<{ Params: { memberId: string } }>('/employee-board-members/:memberId', { config: { policy: orgTree('EDITOR', VIA_EB_MEMBER) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.memberId).success) return badId(reply);
      await service.removeMember(req.params.memberId);
      return reply.code(204).send();
    });

    app.patch<{ Params: { boardId: string } }>('/employee-boards/:boardId/columns', { config: { policy: orgTree('EDITOR', VIA_EB) } }, async (req, reply) => {
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

    app.post<{ Params: { boardId: string } }>('/employee-boards/:boardId/custom-columns', { config: { policy: orgTree('EDITOR', VIA_EB) } }, async (req, reply) => {
      if (!uuid.safeParse(req.params.boardId).success) return badId(reply);
      const body = CreateEmployeeColumnSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      return service.createColumn(req.params.boardId, body.data);
    });

    app.patch<{ Params: { columnId: string } }>(
      '/employee-columns/:columnId',
      { config: { policy: orgTree('EDITOR', viaOrgEntity('employeeColumn', fromParam('columnId'))) } },
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
      { config: { policy: orgTree('EDITOR', viaOrgEntity('employeeColumn', fromParam('columnId'))) } },
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
