// P1 — Board-scoped unified ticket timeline.
import { authFetch } from '../../../../../actions/api';

interface TimelineEvent {
  source: string;
  ts: string;
  title: string;
  actor: string | null;
  ref: string;
}

// `/intelligence/...`, not `/insights/...` — the same defect the sibling
// developers page carried, and for the same reason: nothing in the API serves
// `/insights/*`. `intelligence.routes.ts` registers with no prefix and serves
// `/intelligence/tickets/:key`, so every request here 404'd on route-not-found
// and this page has never worked either.
//
// As on that page, correcting the path changes what a 404 MEANS: the request
// now reaches a real handler whose only 404 is `resolveScope` failing to find
// the board inside the caller's organization. So the board-not-found message
// below is accurate — what was wrong with it was that it replaced the entire
// page, navigation included.
type Outcome = 'ok' | 'not-found' | 'failed';

async function fetchTimeline(
  boardId: string,
  key: string,
): Promise<{ events: TimelineEvent[]; outcome: Outcome }> {
  try {
    const resp = await authFetch(
      `/intelligence/tickets/${encodeURIComponent(key)}?boardId=${encodeURIComponent(boardId)}`,
      { cache: 'no-store' },
    );
    if (resp.status === 404) return { events: [], outcome: 'not-found' };
    if (!resp.ok) return { events: [], outcome: 'failed' };
    return { events: (await resp.json()) as TimelineEvent[], outcome: 'ok' };
  } catch {
    return { events: [], outcome: 'failed' };
  }
}

const SOURCE_TONE: Record<string, string> = {
  jira: 'bg-blue-50 text-blue-700 ring-blue-200',
  github: 'bg-purple-50 text-purple-700 ring-purple-200',
  'github-commit': 'bg-purple-50 text-purple-700 ring-purple-200',
  gitlab: 'bg-orange-50 text-orange-700 ring-orange-200',
  'gitlab-commit': 'bg-orange-50 text-orange-700 ring-orange-200',
  ado: 'bg-sky-50 text-sky-700 ring-sky-200',
  'ado-commit': 'bg-sky-50 text-sky-700 ring-sky-200',
};

export default async function BoardTicketTimelinePage({
  params,
}: {
  params: Promise<{ boardId: string; key: string }>;
}) {
  const { boardId, key } = await params;
  const { events, outcome } = await fetchTimeline(boardId, key);

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
        <a
          href={`/?boardId=${boardId}`}
          className="text-xs text-indigo-600 hover:underline"
        >
          ← Back to board
        </a>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{key}</h1>
        <p className="mt-1 text-sm text-slate-600">
          Unified timeline scoped to this board&apos;s connected sources.
        </p>
      </header>
      {outcome === 'failed' ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Couldn&apos;t load the timeline for <code className="font-mono">{key}</code> just now.
          Try again, or check that this board&apos;s sources have synced.
        </div>
      ) : events.length === 0 ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          No activity for <code className="font-mono">{key}</code> in this board&apos;s sources.
          If no sources are connected, add them in{' '}
          <a href="/settings" className="underline">Settings</a>.
        </div>
      ) : (
        <ol className="relative border-l-2 border-slate-200 pl-6">
          {events.map((e, i) => (
            <li key={`${e.source}-${e.ref}-${i}`} className="mb-6 last:mb-0">
              <div className="absolute -left-[7px] mt-1 h-3 w-3 rounded-full bg-indigo-500" />
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${
                    SOURCE_TONE[e.source] ?? 'bg-slate-50 text-slate-600 ring-slate-200'
                  }`}
                >
                  {e.source}
                </span>
                <time className="text-xs text-slate-500" dateTime={e.ts}>
                  {e.ts}
                </time>
              </div>
              <div className="mt-1 text-sm font-medium text-slate-900">{e.title}</div>
              {e.actor ? <div className="mt-0.5 text-xs text-slate-500">by {e.actor}</div> : null}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
