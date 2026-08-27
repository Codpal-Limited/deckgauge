'use server';

import { revalidatePath } from 'next/cache';
import { apiRequest } from './api';

export async function getEmployeeComments(employeeId: string) {
  const res = await apiRequest(`/org-employees/${employeeId}/comments`);
  return res.json();
}

export async function getEmployeeCommentCounts(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const res = await apiRequest(`/org-employees/comment-counts?ids=${ids.join(',')}`);
  return res.json();
}

export async function createEmployeeComment(
  employeeId: string,
  content: unknown,
  uploadIds: string[],
  authorName?: string,
  /**
   * Author-only visibility. Omitted means public, matching the API's default —
   * so every existing caller keeps its behaviour.
   */
  isPrivate?: boolean,
): Promise<void> {
  await apiRequest(`/org-employees/${employeeId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, authorName, uploadIds, isPrivate }),
  });
  revalidatePath('/org');
}

export async function updateEmployeeComment(
  employeeId: string,
  commentId: string,
  data: { content?: unknown; pinned?: boolean; isPrivate?: boolean },
): Promise<void> {
  await apiRequest(`/org-employees/${employeeId}/comments/${commentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  revalidatePath('/org');
}

export async function deleteEmployeeComment(employeeId: string, commentId: string): Promise<void> {
  await apiRequest(`/org-employees/${employeeId}/comments/${commentId}`, { method: 'DELETE' });
  revalidatePath('/org');
}
