// P1 — Board-scoped developers (AI breakdown) page.
import { DeveloperRow } from '../../../../components/intelligence/charts';
import { authFetch } from '../../../../actions/api';

interface AiRow {
  author_login: string;
  ai_prs: number;
  total_prs: number;
  ai_pct: number;
}

// `/intelligence/...`, not `/insights/...`. The API registers
// `intelligence.routes.ts` with NO prefix and serves
// `/intelligence/ai-breakdown`; nothing anywhere serves `/insights/*`. This page
// asked for the latter, so every request 404'd on route-not-found and the page
// could never have worked on any install, with any data.
//
// Fixing the path CHANGES WHAT A 404 MEANS, which is the part worth stating.
// Before, every 404 was route-not-found and the "Board not found" message was
// noise. Now the request reaches a real handler, and that handler returns 404
// from exactly one place: `resolveScope` failing to find the board within the
// caller's organization (`intelligence.routes.ts`). Permission failures are
// 401/403 and a malformed boardId is 400. So 404 now means precisely "this
// board does not exist, or belongs to another organization" — and "Board not
// found" is the ACCURATE answer to it, not the misleading one.
type Outcome = 'ok' | 'not-found' | 'failed';

async function fetchAi(boardId: string): Promise<{ rows: AiRow[]; outcome: Outcome }> {
  try {
    const resp = await authFetch(
      `/intelligence/ai-breakdown?boardId=${encodeURIComponent(boardId)}`,
      { cache: 'no-store' },
    );
    if (resp.status === 404) return { rows: [], outcome: 'not-found' };
    if (!resp.ok) return { rows: [], outcome: 'failed' };
    return { rows: (await resp.json()) as AiRow[], outcome: 'ok' };
  } catch {
    return { rows: [], outcome: 'failed' };
  }
}

export default async function BoardDevelopersPage({
  params,
}: {
  params: Promise<{ boardId: string }>;
}) {
  const { boardId } = await params;
  const { rows, outcome } = await fetchAi(boardId);

  // The real defect in the old 404 branch was that it replaced the WHOLE page
  // — header, back link and all — so a board-scoped analytics answer also cost
  // the user their navigation. The message stays; the chrome stays with it, and
  // the back link points at the board list rather than at the board the API
  // just said it could not find.
  if (outcome === 'not-found') {
    return (
      <main className="mx-auto max-w-4xl px-6 py-10">
        <header className="mb-6">
          <a href="/" className="text-xs text-indigo-600 hover:underline">
            ← Back to boards
          </a>
          <h1 className="mt-2 text-2xl font-semibold text-slate-900">Board not found</h1>
        </header>
        <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          This board does not exist, or it belongs to another organization.
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6">
        <a href={`/?boardId=${boardId}`} className="text-xs text-indigo-600 hover:underline">
          ← Back to board
        </a>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Developers</h1>
        <p className="mt-1 text-sm text-slate-600">
          Ranked by AI-assisted PR percentage for this board&apos;s sources, last 30 days.
        </p>
      </header>
      {outcome === 'failed' ? (
        // A transport error or a non-404 status. Distinct from both "the board
        // is missing" above and "the board has no sources" below — three
        // states, because the API distinguishes three and collapsing them is
        // what sent the reporter after the wrong problem.
        <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Couldn&apos;t load the AI breakdown just now. Try again, or check that this
          board&apos;s intelligence sources have synced.
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          No intelligence sources connected — open{' '}
          <a href="/settings" className="underline">Settings</a> to add Jira/GitHub/ADO/GitLab
          connections for this board.
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white">
          {rows.map((r) => (
            <DeveloperRow
              key={r.author_login}
              login={r.author_login}
              prsMerged={r.ai_prs}
              aiPct={r.ai_pct}
              medianCycleHours={null}
            />
          ))}
        </div>
      )}
    </main>
  );
}
