'use server';

import { revalidatePath } from 'next/cache';
import type {
  UpdateRoadmapConfigInput,
  RoadmapConfigPayload,
  BoardColumn,
  RoadmapDetail,
  CreateRoadmapInput,
  AddGroupsInput,
  AddSubscriptionInput,
  ReorderRoadmapGroupsInput,
  UpdateRoadmapPrefInput,
  ColumnLayout,
} from '@deckgauge/shared';
import { authFetch, apiRequest } from './api';
import { auth } from '@/auth';

// ---------------------------------------------------------------------------
// Loaders (server-side data fetching for the roadmap page)
// ---------------------------------------------------------------------------

export interface RoadmapViewPayload {
  config: {
    id: string;
    boardViewId: string;
    startDate: string;
    visibleQuarters: number;
    sizeDurations: Record<string, number>;
    defaultSizeWeeks: number;
    hiddenGroupIds: string[];
  };
  groups: { id: string; name: string; color: string; position: number }[];
  projects: {
    id: string;
    name: string;
    status: string;
    groupId: string | null;
    order: number | null;
    assigneeId: string | null;
    sizeLabel: string | null;
    sizeWeeks: number | null;
    startDate: string | null;
    endDate: string | null;
    durationCode: string | null;
  }[];
}

export async function loadRoadmapView(
  boardId: string,
  viewId?: string,
): Promise<RoadmapViewPayload> {
  const qs = viewId ? `?viewId=${encodeURIComponent(viewId)}` : '';
  const res = await authFetch(`/boards/${boardId}/roadmap${qs}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to load roadmap view (${res.status})`);
  }
  return res.json() as Promise<RoadmapViewPayload>;
}

export async function loadBoardColumns(boardId: string): Promise<BoardColumn[]> {
  try {
    const res = await authFetch(`/boards/${boardId}/columns`, { cache: 'no-store' });
    if (!res.ok) return [];
    return res.json() as Promise<BoardColumn[]>;
  } catch {
    return [];
  }
}

export async function getBoardRole(
  _boardId: string,
): Promise<'OWNER' | 'EDITOR' | 'VIEWER'> {
  // KNOWN PHANTOM-OWNER SITE: still grants OWNER to any authenticated caller.
  // app/page.tsx no longer does this (see fetchMyRole) — roadmaps have no
  // equivalent `GET /roadmaps/:id/my-role` endpoint yet, so there is nothing
  // real to wire up until roadmap sharing lands in a later phase.
  try {
    const session = await auth();
    return session ? 'OWNER' : 'VIEWER';
  } catch {
    return 'VIEWER';
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function setRoadmapSchedule(
  boardId: string,
  projectId: string,
  input: { startDate?: string | null; endDate?: string | null; durationCode?: string | null },
): Promise<{ ok: boolean }> {
  try {
    await apiRequest(`/boards/${boardId}/projects/${projectId}/roadmap-schedule`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function setBoardHiddenSystemFields(
  boardId: string,
  hiddenSystemFields: string[],
): Promise<{ ok: boolean }> {
  try {
    await apiRequest(`/boards/${boardId}/hidden-system-fields`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hiddenSystemFields }),
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function setBoardColumnLayout(
  boardId: string,
  layout: ColumnLayout,
): Promise<{ ok: boolean }> {
  try {
    await apiRequest(`/boards/${boardId}/column-layout`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout),
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function updateRoadmapConfig(
  boardId: string,
  viewId: string,
  input: UpdateRoadmapConfigInput,
): Promise<RoadmapConfigPayload> {
  const res = await apiRequest(`/boards/${boardId}/views/${viewId}/roadmap-config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  // The API wraps the row in a { config } envelope; unwrap it so callers get
  // the bare payload (they read updated.hiddenGroupIds / .visibleQuarters etc.).
  const body = (await res.json()) as { config: RoadmapConfigPayload };
  return body.config;
}

// ---------------------------------------------------------------------------
// Cross-board Roadmap actions (Task 12 — sidebar + create)
// ---------------------------------------------------------------------------

export async function createRoadmap(name: string): Promise<{ id: string; name: string }> {
  const input: CreateRoadmapInput = { name };
  const res = await apiRequest('/roadmaps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  revalidatePath('/');
  return res.json();
}

export async function fetchRoadmap(id: string): Promise<RoadmapDetail> {
  const session = await auth();
  if (!session) throw new Error('Unauthenticated');
  const res = await authFetch(`/roadmaps/${id}`, { revalidate: 0 });
  if (!res.ok) throw new Error(`Failed to fetch roadmap (${res.status})`);
  return res.json();
}

export async function addGroups(roadmapId: string, input: AddGroupsInput): Promise<void> {
  await apiRequest(`/roadmaps/${roadmapId}/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function addSubscription(
  roadmapId: string,
  input: AddSubscriptionInput,
): Promise<void> {
  await apiRequest(`/roadmaps/${roadmapId}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function reorderGroups(
  roadmapId: string,
  input: ReorderRoadmapGroupsInput,
): Promise<void> {
  await apiRequest(`/roadmaps/${roadmapId}/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// Cross-board (and same-board) item move. Items are real Projects, so this
// hits the shared project move endpoint, not a roadmap-scoped route.
export async function moveItem(
  itemId: string,
  targetGroupId: string,
): Promise<{ dropped: { ownerCleared: boolean; statusReset: boolean; columnsDropped: string[] } }> {
  const res = await apiRequest(`/projects/${itemId}/move-to-board`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetGroupId }),
  });
  return res.json();
}

export async function updateRoadmapPref(
  roadmapId: string,
  input: UpdateRoadmapPrefInput,
): Promise<void> {
  await apiRequest(`/me/roadmap-prefs/${roadmapId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  revalidatePath('/');
}

export async function updateRoadmapGanttConfig(
  roadmapId: string,
  patch: UpdateRoadmapConfigInput,
): Promise<RoadmapConfigPayload> {
  const res = await apiRequest(`/roadmaps/${roadmapId}/gantt-config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return res.json();
}

export async function deleteRoadmap(id: string): Promise<void> {
  await apiRequest(`/roadmaps/${id}`, { method: 'DELETE' });
  revalidatePath('/');
}

// ---------------------------------------------------------------------------
// Roadmap-scoped item-write actions (Task 11)
// These hit the roadmap-role-gated endpoints added in Task 10.
// ---------------------------------------------------------------------------

export async function setRoadmapItemSchedule(
  roadmapId: string,
  projectId: string,
  patch: { startDate?: string | null; endDate?: string | null; durationCode?: string | null },
): Promise<{ ok: boolean }> {
  try {
    await apiRequest(`/roadmaps/${roadmapId}/items/${projectId}/schedule`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function updateRoadmapItemField(
  roadmapId: string,
  projectId: string,
  field: string,
  value: string,
): Promise<void> {
  await apiRequest(`/roadmaps/${roadmapId}/items/${projectId}/field`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field, value }),
  });
}

export async function moveRoadmapItem(
  roadmapId: string,
  projectId: string,
  patch: { groupId?: string; order?: number },
): Promise<void> {
  await apiRequest(`/roadmaps/${roadmapId}/items/${projectId}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}
