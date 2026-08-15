'use server';

import { revalidatePath } from 'next/cache';
import type { AdvisorConfigInput } from '@deckgauge/shared';
import { authFetch } from './api';

/**
 * Server actions for the Advisor onboarding page (`settings/advisor`). Every
 * action *returns* a result union rather than throwing — a thrown error
 * inside a Next.js server action is masked behind an opaque digest before it
 * reaches the browser, so the API's message (e.g. "invalid config") would be
 * lost. Returning it keeps it intact. Mirrors the convention in
 * `board-sources.ts`.
 */

/** Extract a human-readable message from a non-ok API response. */
async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Body was not JSON — fall through to the raw text.
  }
  return text || `Request failed (${res.status})`;
}

/** Shape of `GET /advisor/config` — never includes the raw API key. */
export type AdvisorConfigStatus =
  | { configured: false }
  | { configured: true; provider: 'anthropic'; model: string; hasApiKey: boolean }
  | { configured: true; provider: 'ollama'; model: string; baseUrl: string };

export type GetAdvisorConfigResult =
  | { ok: true; config: AdvisorConfigStatus }
  | { ok: false; error: string };

export async function getAdvisorConfig(): Promise<GetAdvisorConfigResult> {
  const res = await authFetch('/advisor/config', { method: 'GET' });
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  const config = (await res.json()) as AdvisorConfigStatus;
  return { ok: true, config };
}

export type SaveAdvisorConfigResult = { ok: true } | { ok: false; error: string };

export async function saveAdvisorConfig(
  input: AdvisorConfigInput,
): Promise<SaveAdvisorConfigResult> {
  const res = await authFetch('/advisor/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return { ok: false, error: await readApiError(res) };
  revalidatePath('/settings/advisor');
  return { ok: true };
}

/** Mirrors `AdvisorTestConnectionResult` from the API's advisor-config service. */
export interface TestAdvisorConfigResult {
  ok: boolean;
  model: string;
  latencyMs?: number;
  error?: string;
}

export async function testAdvisorConfig(
  input: AdvisorConfigInput,
): Promise<TestAdvisorConfigResult> {
  const res = await authFetch('/advisor/config/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    return { ok: false, model: input.model, error: await readApiError(res) };
  }
  return (await res.json()) as TestAdvisorConfigResult;
}
