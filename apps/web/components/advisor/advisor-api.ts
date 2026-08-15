import type {
  AdvisorAppendMessageInput,
  AdvisorSessionSummaryDto,
  AdvisorSessionTranscriptDto,
} from '@deckgauge/shared';

/**
 * Thin fetch wrappers over the Next.js proxies, so the provider stays about
 * state.
 *
 * EVERY function here is total — none of them ever rejects. Their callers are
 * fire-and-forget (`void advisor.send(...)`, `void advisor.resume(...)`,
 * `listSessions(...).then(...)`), so a rejection escaping one of them is not a
 * caught error but an unhandled rejection that strands the UI mid-flight: a
 * composer left disabled with `isAsking` stuck true, or a dropdown stuck on
 * "Loading sessions…" forever. `fetch` rejects on any network blip and
 * `res.json()` throws on a non-JSON body (an HTML error page from a proxy, a
 * truncated response), so both have to be inside the try, not just `!res.ok`.
 */

/**
 * A failed list is NOT an empty list: rendering "no earlier sessions" for a
 * 500 tells the user their history does not exist. The caller has to be able
 * to tell the two apart, so this returns a result rather than an array.
 */
export type AdvisorSessionListResult =
  | { ok: true; sessions: AdvisorSessionSummaryDto[] }
  | { ok: false };

export async function listSessions(boardId: string): Promise<AdvisorSessionListResult> {
  try {
    const res = await fetch(`/api/advisor/boards/${boardId}/sessions`);
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { sessions?: AdvisorSessionSummaryDto[] };
    return { ok: true, sessions: body.sessions ?? [] };
  } catch {
    return { ok: false };
  }
}

export async function createSession(boardId: string): Promise<AdvisorSessionSummaryDto | null> {
  try {
    const res = await fetch(`/api/advisor/boards/${boardId}/sessions`, { method: 'POST' });
    if (!res.ok) return null;
    return (await res.json()) as AdvisorSessionSummaryDto;
  } catch {
    return null;
  }
}

export async function getSession(
  boardId: string,
  sessionId: string,
): Promise<AdvisorSessionTranscriptDto | null> {
  try {
    const res = await fetch(`/api/advisor/boards/${boardId}/sessions/${sessionId}`);
    if (!res.ok) return null;
    return (await res.json()) as AdvisorSessionTranscriptDto;
  } catch {
    return null;
  }
}

export async function deleteSession(boardId: string, sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/advisor/boards/${boardId}/sessions/${sessionId}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Appends one turn.
 *
 * Never throws: a transcript row that fails to persist must not break the
 * answer the user is currently reading, and the panel holds the turn in memory
 * for this session either way. But it is never silent — a persistence outage
 * that logged nothing would show up only as a mysteriously empty history list
 * much later, so every failure is logged (matching `GroupList`'s
 * `console.error` convention for non-fatal client-side failures).
 */
export async function appendMessage(
  boardId: string,
  sessionId: string,
  input: AdvisorAppendMessageInput,
): Promise<void> {
  try {
    const res = await fetch(`/api/advisor/boards/${boardId}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      console.error('[advisor] failed to persist a message', {
        sessionId,
        role: input.role,
        status: res.status,
      });
    }
  } catch (err) {
    console.error('[advisor] failed to persist a message', { sessionId, role: input.role }, err);
  }
}
