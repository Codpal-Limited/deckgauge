import type { Project, Group } from "@deckgauge/shared";

export type ProjectWithFields = Project & { fieldValues?: Record<string, string> };
export type GroupTree = (Group & { projects: ProjectWithFields[] })[];

/**
 * Apply a partial patch to a single project identified by id.
 * Returns the original tree reference if the id is not found, so consumers can
 * detect no-op updates by reference equality.
 */
export function setProjectField(
  tree: GroupTree,
  projectId: string,
  patch: Partial<ProjectWithFields>,
): GroupTree {
  let found = false;
  const next = tree.map((g) => ({
    ...g,
    projects: g.projects.map((p) => {
      if (p.id !== projectId) return p;
      found = true;
      return { ...p, ...patch };
    }),
  }));
  return found ? next : tree;
}

export function setProjectFieldValue(
  tree: GroupTree,
  projectId: string,
  columnId: string,
  value: string,
): GroupTree {
  let found = false;
  const next = tree.map((g) => ({
    ...g,
    projects: g.projects.map((p) => {
      if (p.id !== projectId) return p;
      found = true;
      return { ...p, fieldValues: { ...(p.fieldValues ?? {}), [columnId]: value } };
    }),
  }));
  return found ? next : tree;
}

export function removeProject(tree: GroupTree, projectId: string): GroupTree {
  let found = false;
  const next = tree.map((g) => {
    const filtered = g.projects.filter((p) => {
      if (p.id !== projectId) return true;
      found = true;
      return false;
    });
    return found && filtered.length !== g.projects.length ? { ...g, projects: filtered } : g;
  });
  return found ? next : tree;
}

export function makeTempId(): string {
  return `temp:${crypto.randomUUID()}`;
}

export function isTempId(id: string): boolean {
  return id.startsWith("temp:");
}

export function addProject(
  tree: GroupTree,
  groupId: string,
  project: ProjectWithFields,
): GroupTree {
  let found = false;
  const next = tree.map((g) => {
    if (g.id !== groupId) return g;
    found = true;
    return { ...g, projects: [...g.projects, project] };
  });
  return found ? next : tree;
}

export function setGroupField(
  tree: GroupTree,
  groupId: string,
  patch: Partial<Group>,
): GroupTree {
  let found = false;
  const next = tree.map((g) => {
    if (g.id !== groupId) return g;
    found = true;
    return { ...g, ...patch };
  });
  return found ? next : tree;
}

export function moveProject(
  tree: GroupTree,
  projectId: string,
  targetGroupId: string,
  // `number | null`, matching the field it is assigned straight into:
  // ProjectWithFields.order is nullable, and per the note on
  // reorderItemInTree below most projects carry a NULL order until first
  // dragged. Both call sites pass `project.order` and so could always be null.
  order: number | null,
): GroupTree {
  let moving: ProjectWithFields | null = null;
  const stripped = tree.map((g) => {
    const remaining = g.projects.filter((p) => {
      if (p.id !== projectId) return true;
      moving = { ...p, groupId: targetGroupId, order };
      return false;
    });
    return remaining.length === g.projects.length ? g : { ...g, projects: remaining };
  });
  if (!moving) return tree;
  const captured: ProjectWithFields = moving;
  return stripped.map((g) =>
    g.id === targetGroupId ? { ...g, projects: [...g.projects, captured] } : g,
  );
}

export interface ItemReorderResult {
  /** The optimistically reordered tree. */
  tree: GroupTree;
  /** Batch payload for the /projects/reorder endpoint (target group only). */
  updates: { id: string; order: number; groupId: string }[];
}

/**
 * Move a project to a new index within its group, or into another group at the
 * dropped position, then renumber the ENTIRE target group with sequential
 * `order` values (0, 1, 2, …).
 *
 * Sequential renumbering is deliberate. Most projects have a NULL `order` in the
 * DB (only items previously dragged carry a value). Computing a single fractional
 * `order` from NULL neighbours collapses every interior drop to the same number,
 * which the server's `order ASC NULLS LAST` sort pushes to the top of the group —
 * so only top/bottom drops ever stuck. Renumbering gives every item a distinct,
 * concrete order so the item lands exactly where it was dropped, and heals the
 * NULL-order data as a side effect.
 *
 * Returns null when the move is invalid (missing group/project) or a no-op.
 */
export function reorderItemInTree(
  tree: GroupTree,
  activeGroupId: string,
  activeProjectId: string,
  overGroupId: string,
  overProjectId: string,
): ItemReorderResult | null {
  const sourceGroup = tree.find((g) => g.id === activeGroupId);
  const targetGroup = tree.find((g) => g.id === overGroupId);
  if (!sourceGroup || !targetGroup) return null;

  const active = sourceGroup.projects.find((p) => p.id === activeProjectId);
  if (!active) return null;

  if (activeGroupId === overGroupId) {
    const from = targetGroup.projects.findIndex((p) => p.id === activeProjectId);
    const to = targetGroup.projects.findIndex((p) => p.id === overProjectId);
    if (from === -1 || to === -1 || from === to) return null;
  }

  // Guard against stale local state that can transiently contain the same id
  // in multiple groups: strip it globally first, then insert once.
  const strippedTree = tree.map((g) => ({
    ...g,
    projects: g.projects.filter((p) => p.id !== activeProjectId),
  }));
  const strippedTarget = strippedTree.find((g) => g.id === overGroupId);
  if (!strippedTarget) return null;

  const overIndex = strippedTarget.projects.findIndex((p) => p.id === overProjectId);
  const insertAt = overIndex === -1 ? strippedTarget.projects.length : overIndex;
  const targetProjects: ProjectWithFields[] = [...strippedTarget.projects];
  targetProjects.splice(insertAt, 0, { ...active, groupId: overGroupId });

  const renumberedTarget = targetProjects.map((p, i) => ({
    ...p,
    order: i,
    groupId: overGroupId,
  }));
  const updates = renumberedTarget.map((p, i) => ({
    id: p.id,
    order: i,
    groupId: overGroupId,
  }));

  const next = strippedTree.map((g) =>
    g.id === overGroupId ? { ...g, projects: renumberedTarget } : g,
  );

  return { tree: next, updates };
}

export function removeGroup(tree: GroupTree, groupId: string): GroupTree {
  const next = tree.filter((g) => g.id !== groupId);
  return next.length === tree.length ? tree : next;
}

export function addGroup(tree: GroupTree, group: Group & { projects: ProjectWithFields[] }): GroupTree {
  return [...tree, group];
}

export function applyBulkPatch(
  tree: GroupTree,
  projectIds: string[],
  patch: Partial<ProjectWithFields>,
): GroupTree {
  const ids = new Set(projectIds);
  return tree.map((g) => ({
    ...g,
    projects: g.projects.map((p) => (ids.has(p.id) ? { ...p, ...patch } : p)),
  }));
}

export function applyBulkFieldValue(
  tree: GroupTree,
  projectIds: string[],
  columnId: string,
  value: string,
): GroupTree {
  const ids = new Set(projectIds);
  return tree.map((g) => ({
    ...g,
    projects: g.projects.map((p) =>
      ids.has(p.id)
        ? { ...p, fieldValues: { ...(p.fieldValues ?? {}), [columnId]: value } }
        : p,
    ),
  }));
}

export function removeProjects(tree: GroupTree, projectIds: string[]): GroupTree {
  const ids = new Set(projectIds);
  return tree.map((g) => ({
    ...g,
    projects: g.projects.filter((p) => !ids.has(p.id)),
  }));
}
