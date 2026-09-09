interface SubtreeNode {
  id: string;
  managerId: string | null;
  isVacancy: boolean;
}

/**
 * The chosen node plus all descendants via the managerId closure, excluding
 * vacancies. rootId === null returns every non-vacancy id. An unknown or
 * vacancy root returns [].
 *
 * The vacancy exclusion is what separates this from `collectSubtree` in
 * `org-tree-edit.ts`, which walks the same closure and keeps everything because
 * it feeds a DELETE. Neither can stand in for the other: this one would leave
 * orphaned vacancy rows behind a branch delete, and that one would put empty
 * seats on a board.
 */
export function collectSubtreeEmployeeIds(
  employees: SubtreeNode[],
  rootId: string | null,
): string[] {
  const real = employees.filter((e) => !e.isVacancy);
  if (rootId === null) return real.map((e) => e.id);

  const root = real.find((e) => e.id === rootId);
  if (!root) return [];

  const childrenByManager = new Map<string, SubtreeNode[]>();
  for (const e of real) {
    if (!e.managerId) continue;
    const list = childrenByManager.get(e.managerId) ?? [];
    list.push(e);
    childrenByManager.set(e.managerId, list);
  }

  const collected: string[] = [];
  const stack: SubtreeNode[] = [root];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    collected.push(node.id);
    for (const child of childrenByManager.get(node.id) ?? []) stack.push(child);
  }
  return collected;
}
