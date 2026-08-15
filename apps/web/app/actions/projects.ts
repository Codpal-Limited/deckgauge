"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { boardTag } from "../utils/cache-tags";
import { apiRequest } from "./api";

// --- Projects ---

export interface ProjectFormData {
  name: string;
  owner: string;
  status: string;
  description?: string;
  boardId?: string;
  groupId?: string;
  ownerId?: string | null;
  statusId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  dueDate?: string | null;
  durationCode?: string | null;
  costClassification?: 'CAPEX' | 'OPEX' | null;
}

export type ProjectUpdateData = Partial<ProjectFormData> & {
  // Clears a manual Owner override so it follows the synced Assignee again.
  resetOwnerToAssignee?: boolean;
};

// When boardId is known, expire the per-board Data Cache tag so the next server
// render reads fresh groups/rows. High-frequency edits (drag reorder, inline
// field edits) stop here — a route revalidation on every drop would refetch the
// whole board (the over-fetch removed in 21981fb3).
//
// `revalidateRoute` additionally busts the client-side Router Cache for `/`.
// Tag invalidation alone does NOT reliably purge the `/` segment from the Router
// Cache once the user has soft-navigated away (e.g. to the Sources tab) and back
// — a known Next 14 limitation for a route that isn't currently active. Without
// it, structural changes (create/delete of a group, row, or column) persist in
// the DB but the board replays the stale cached RSC payload on tab-return: a new
// group/row/column vanishes and a deleted one reappears. Pass it for those ops.
function invalidate(
  boardId?: string,
  opts?: { revalidateRoute?: boolean },
): void {
  if (boardId) {
    revalidateTag(boardTag(boardId));
    if (opts?.revalidateRoute) revalidatePath("/");
  } else {
    revalidatePath("/");
  }
}

export async function createProject(
  data: ProjectFormData,
  boardId?: string,
): Promise<void> {
  if (!data.name.trim()) throw new Error("Name is required");
  await apiRequest("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  invalidate(boardId ?? data.boardId, { revalidateRoute: true });
}

export async function updateProject(
  id: string,
  data: ProjectUpdateData,
  boardId?: string,
): Promise<void> {
  if (data.name !== undefined && !data.name.trim()) {
    throw new Error("Name is required");
  }
  await apiRequest(`/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  invalidate(boardId);
}

export async function patchProject(
  id: string,
  data: Partial<ProjectFormData>,
  boardId?: string,
): Promise<void> {
  await apiRequest(`/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  invalidate(boardId);
}

export async function deleteProject(
  id: string,
  boardId?: string,
): Promise<void> {
  await apiRequest(`/projects/${id}`, { method: "DELETE" });
  invalidate(boardId, { revalidateRoute: true });
}

// Bulk delete for the board's "delete selected" action. The previous
// implementation looped deleteProject() per id — one server action + one cache
// revalidation each — which timed out on large selections (e.g. 16k+ rows).
// Here we batch the ids into a few bulk-delete requests and invalidate once.
export async function deleteProjects(
  ids: string[],
  boardId?: string,
): Promise<{ deleted: number }> {
  if (ids.length === 0) return { deleted: 0 };
  const BATCH_SIZE = 5000;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const res = await apiRequest("/projects/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: batch }),
    });
    const data = (await res.json()) as { deleted: number };
    deleted += data.deleted;
  }
  invalidate(boardId, { revalidateRoute: true });
  return { deleted };
}

// Client-callable single page of a board's projects. Used by the board's
// progressive loader to stream rows in after first paint instead of shipping
// the whole board through the SSR/RSC payload. `cache: "no-store"` because the
// loader is driven client-side and must not serve a stale page.
export async function fetchProjectsPage(
  boardId: string,
  page: number,
  pageSize: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ items: any[]; total: number; hasMore: boolean }> {
  try {
    const res = await apiRequest(
      `/projects?boardId=${boardId}&page=${page}&pageSize=${pageSize}`,
      { cache: "no-store" },
    );
    const data = await res.json();
    return {
      items: Array.isArray(data?.items) ? data.items : [],
      total: typeof data?.total === "number" ? data.total : 0,
      hasMore: Boolean(data?.hasMore),
    };
  } catch {
    return { items: [], total: 0, hasMore: false };
  }
}

// Client-callable comment counts for a specific set of project ids. The
// progressive loader fetches counts per loaded page (a few thousand ids max),
// avoiding the old all-ids-in-one-URL call that could exceed URL limits.
export async function fetchCommentCounts(
  projectIds: string[],
): Promise<Record<string, number>> {
  if (projectIds.length === 0) return {};
  // Chunk ids so the `?projectIds=` query string stays well under the API
  // server's header-size limit (~16KB ≈ 400 uuids); 200 keeps wide margin.
  const CHUNK_SIZE = 200;
  const result: Record<string, number> = {};
  for (let i = 0; i < projectIds.length; i += CHUNK_SIZE) {
    const chunk = projectIds.slice(i, i + CHUNK_SIZE);
    try {
      const res = await apiRequest(
        `/projects/comment-counts?projectIds=${chunk.join(",")}`,
        { cache: "no-store" },
      );
      Object.assign(result, (await res.json()) as Record<string, number>);
    } catch {
      // Skip this chunk's badges rather than fail the whole load.
    }
  }
  return result;
}

export async function duplicateProject(
  projectId: string,
  name: string,
  data: ProjectFormData,
  boardId?: string,
): Promise<void> {
  await apiRequest("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...data, name: `Copy of ${name}` }),
  });
  invalidate(boardId ?? data.boardId, { revalidateRoute: true });
}

export interface ReorderUpdate {
  id: string;
  // Both order and groupId are optional, mirroring the API's ReorderItemSchema.
  // Single-drag reorder passes both; bulk move-to-group passes only groupId
  // (the API skips the order column when omitted, so projects whose Jira-sync
  // left order=null are not overwritten with `undefined`).
  order?: number;
  groupId?: string;
}

export async function reorderItems(
  updates: ReorderUpdate[],
  boardId?: string,
): Promise<void> {
  await apiRequest("/projects/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  invalidate(boardId);
}

// --- Columns ---

export interface CreateColumnInput {
  name: string;
  type: string;
  config?: Record<string, unknown>;
}

export async function createColumn(
  boardId: string,
  data: CreateColumnInput,
): Promise<{ error?: string }> {
  if (!data.name.trim()) return { error: "Column name is required" };
  try {
    await apiRequest(`/boards/${boardId}/columns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    invalidate(boardId, { revalidateRoute: true });
    return {};
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to create column";
    return { error: message };
  }
}

export async function updateColumn(
  columnId: string,
  data: { name?: string; order?: number },
  boardId?: string,
): Promise<void> {
  await apiRequest(`/columns/${columnId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  invalidate(boardId);
}

export async function updateFieldValue(
  projectId: string,
  columnId: string,
  value: string,
  boardId?: string,
): Promise<void> {
  await apiRequest(`/projects/${projectId}/fields`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ columnId, value }]),
  });
  invalidate(boardId);
}

export async function deleteColumn(
  columnId: string,
  boardId?: string,
): Promise<void> {
  await apiRequest(`/columns/${columnId}`, { method: "DELETE" });
  invalidate(boardId, { revalidateRoute: true });
}

// --- Groups ---

export async function fetchGroups(
  boardId: string,
): Promise<{ id: string; name: string; color: string }[]> {
  const res = await apiRequest(`/boards/${boardId}/groups`);
  return res.json();
}

export async function createGroup(
  boardId: string,
  name: string,
): Promise<void> {
  await apiRequest("/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, boardId }),
  });
  invalidate(boardId, { revalidateRoute: true });
}

export async function updateGroup(
  groupId: string,
  data: { name?: string; color?: string },
  boardId?: string,
): Promise<void> {
  await apiRequest(`/groups/${groupId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  invalidate(boardId);
}

export async function deleteGroup(
  groupId: string,
  boardId?: string,
): Promise<void> {
  await apiRequest(`/groups/${groupId}`, { method: "DELETE" });
  invalidate(boardId, { revalidateRoute: true });
}

export async function reorderGroups(
  updates: { id: string; position: number }[],
  boardId?: string,
): Promise<void> {
  await apiRequest("/groups/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  invalidate(boardId);
}

// --- Boards ---

export async function updateBoard(
  boardId: string,
  data: { name?: string; description?: string | null },
): Promise<void> {
  await apiRequest(`/boards/${boardId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  invalidate(boardId);
}

export async function deleteBoard(boardId: string): Promise<void> {
  await apiRequest(`/boards/${boardId}`, { method: "DELETE" });
  invalidate(boardId);
}

// --- Automations ---

export async function fetchAutomations(boardId: string) {
  const res = await apiRequest(`/boards/${boardId}/automations`);
  return res.json();
}

export async function createAutomation(
  boardId: string,
  data: {
    name: string;
    trigger: { type: string; field?: string; value?: string };
    action: {
      type: string;
      targetGroupId?: string;
      targetStatus?: string;
      message?: string;
    };
  },
): Promise<void> {
  await apiRequest(`/boards/${boardId}/automations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  invalidate(boardId);
}

export async function updateAutomation(
  automationId: string,
  data: { enabled?: boolean; name?: string },
  boardId?: string,
): Promise<void> {
  await apiRequest(`/automations/${automationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  invalidate(boardId);
}

export async function deleteAutomation(
  automationId: string,
  boardId?: string,
): Promise<void> {
  await apiRequest(`/automations/${automationId}`, { method: "DELETE" });
  invalidate(boardId);
}
