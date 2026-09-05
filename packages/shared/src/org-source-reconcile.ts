import { mapGraphUserToEmployee, type GraphUser, type MappedGraphEmployee } from './graph-user-map.js';

export interface ScopeNode {
  user: GraphUser;
  managerGraphId: string | null;
  position: number;
}

export interface OrgSourceExistingRow {
  id: string;
  msGraphId: string | null;
}

export interface ReconcileUpsert {
  msGraphId: string;
  managerGraphId: string | null;
  position: number;
  mapped: MappedGraphEmployee;
}

export interface ReconcilePlan {
  upserts: ReconcileUpsert[];
  departedEmployeeIds: string[];
}

export function reconcileScope(existing: OrgSourceExistingRow[], scope: ScopeNode[]): ReconcilePlan {
  const inScope = new Set(scope.map((n) => n.user.id));
  const upserts: ReconcileUpsert[] = scope.map((n) => ({
    msGraphId: n.user.id,
    managerGraphId: n.managerGraphId,
    position: n.position,
    mapped: mapGraphUserToEmployee(n.user),
  }));
  const departedEmployeeIds = existing
    .filter((e) => e.msGraphId !== null && !inScope.has(e.msGraphId))
    .map((e) => e.id);
  return { upserts, departedEmployeeIds };
}
