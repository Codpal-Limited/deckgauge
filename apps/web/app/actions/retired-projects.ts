'use server';
import { revalidatePath } from 'next/cache';
import type {
  RetiredJiraProjectDto,
  CreateRetiredJiraProjectInput,
  UpdateRetiredJiraProjectInput,
} from '@deckgauge/shared';
import { authFetch } from './api';
import { readApiError } from '../lib/read-api-error';

// Result union (never throw across the server-action boundary — Next masks
// thrown errors as opaque digests, hiding the real API message from the UI).
export type ActionResult = { ok: true } | { ok: false; error: string };

export async function listRetiredProjects(): Promise<RetiredJiraProjectDto[]> {
  const res = await authFetch('/retired-projects', { method: 'GET' });
  if (!res.ok) throw new Error(`list retired projects failed: ${res.status}`);
  return res.json();
}

export async function createRetiredProject(
  input: CreateRetiredJiraProjectInput,
): Promise<ActionResult> {
  const res = await authFetch('/retired-projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  revalidatePath('/sources');
  return { ok: true };
}

export async function updateRetiredProject(
  projectKey: string,
  input: UpdateRetiredJiraProjectInput,
): Promise<ActionResult> {
  const res = await authFetch(`/retired-projects/${encodeURIComponent(projectKey)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  revalidatePath('/sources');
  return { ok: true };
}

export async function deleteRetiredProject(projectKey: string): Promise<ActionResult> {
  const res = await authFetch(`/retired-projects/${encodeURIComponent(projectKey)}`, {
    method: 'DELETE',
  });
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  revalidatePath('/sources');
  return { ok: true };
}
