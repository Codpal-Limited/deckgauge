export function wouldCreateCycle(
  employees: { id: string; managerId: string | null }[],
  employeeId: string,
  newManagerId: string | null
): boolean {
  if (newManagerId === null) return false;
  if (newManagerId === employeeId) return true;
  const byId = new Map(employees.map((e) => [e.id, e]));
  // walk up from the proposed manager; if we reach employeeId, it's a descendant -> cycle
  let cur: string | null = newManagerId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === employeeId) return true;
    if (seen.has(cur)) break; // guard against pre-existing corruption
    seen.add(cur);
    cur = byId.get(cur)?.managerId ?? null;
  }
  return false;
}

/**
 * Every id in the branch rooted at `rootId`, the root included.
 *
 * This is the delete set: removing a manager removes the people under them, so
 * the traversal and the confirmation count must come from the same place — the
 * API deletes what this returns and the UI names what this returns, which is
 * why it lives in `shared` rather than in either one.
 *
 * `seen` is not defensive padding. `wouldCreateCycle` guards WRITES, but rows
 * already in a cycle (imported hierarchy, a manager pointer written before that
 * guard existed) would otherwise spin here forever, and this runs inside a
 * request.
 *
 * NOT interchangeable with `collectSubtreeEmployeeIds` in
 * `employee-board-subtree.ts`, which walks the same closure but EXCLUDES
 * vacancies. That is right for picking board members and wrong here: deleting a
 * branch has to delete the vacancy rows in it too, or they survive as orphans
 * pointing at a manager that no longer exists. Do not merge the two.
 */
export function collectSubtree(
  employees: { id: string; managerId: string | null }[],
  rootId: string
): string[] {
  if (!employees.some((e) => e.id === rootId)) return [];
  const childrenOf = new Map<string, string[]>();
  for (const e of employees) {
    if (e.managerId === null) continue;
    const siblings = childrenOf.get(e.managerId);
    if (siblings) siblings.push(e.id);
    else childrenOf.set(e.managerId, [e.id]);
  }
  const collected: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    collected.push(id);
    for (const child of childrenOf.get(id) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return collected;
}
