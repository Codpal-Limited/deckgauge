'use client';

import { useEffect, useState } from 'react';
import type { IntervalsResponse, StatusDurationDto, TicketTimelineEvent } from '@deckgauge/shared';
import type { TicketActivityResult } from '../../actions/timesheet';
import { formatHours } from '../lib/timesheet-ui';
import {
  activityKind,
  formatDuration,
  formatLocalDate,
  formatLocalDateTime,
  formatUtcTooltip,
  stripSegments,
  type ActivityKind,
} from '../lib/drawer-format';

interface TicketDetailDrawerProps {
  data: IntervalsResponse | null;
  /**
   * Hours the GRID attributed to this engineer for this issue, in seconds.
   *
   * Passed in rather than derived here, and that is deliberate. This number
   * comes out of the engine (normalized across concurrent tickets, then daily
   * capped), so it is the only figure guaranteed to equal the cell the user
   * clicked. Re-deriving it from `data.intervals` would produce a second,
   * larger answer — those are raw wall-clock spans.
   *
   * Caveat worth knowing: `aggregateEmployeeTasks` groups by
   * `issueKey|classification`, so an issue reclassified CAPEX↔OPEX mid-window
   * has TWO grid rows and this is the clicked row's share, not the issue's
   * whole total.
   */
  countedSeconds: number;
  activity: TicketActivityResult | null;
  loading: boolean;
  onClose: () => void;
}

/** Monday-style status tones, matching the board's `status-*` config colours. */
const STATUS_TONE: Record<string, string> = {
  'in progress': '#fdab3d',
  'code review': '#a855f7',
  'in review': '#a855f7',
  'in qa': '#579bfc',
  blocked: '#e2445c',
  'at risk': '#e44258',
  done: '#00c875',
  closed: '#00c875',
  resolved: '#00c875',
  'to do': '#c4c4c4',
  todo: '#c4c4c4',
  open: '#c4c4c4',
  backlog: '#c4c4c4',
};

function statusTone(status: string): string {
  return STATUS_TONE[status.toLowerCase().replace(/[\s_-]+/g, ' ').trim()] ?? '#94a3b8';
}

const SOURCE_LABEL: Record<string, string> = {
  jira: 'Jira',
  github: 'Pull request',
  gitlab: 'Merge request',
  ado: 'Pull request',
  'github-commit': 'Commit',
  'gitlab-commit': 'Commit',
  'ado-commit': 'Commit',
};

const KIND_DOT: Record<ActivityKind, string> = {
  status: 'border-amber-400',
  commit: 'border-indigo-500',
  pr: 'border-purple-400',
  other: 'border-slate-300',
};

const FILTERS: { value: ActivityKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'commit', label: 'Commits' },
  { value: 'pr', label: 'PRs' },
  { value: 'status', label: 'Status' },
];

const SECTION = 'border-b border-slate-200 px-4 py-4';
const SECTION_TITLE =
  'text-[11px] font-bold uppercase tracking-wider text-slate-400';

export function TicketDetailDrawer({
  data,
  countedSeconds,
  activity,
  loading,
  onClose,
}: TicketDetailDrawerProps) {
  const [filter, setFilter] = useState<ActivityKind | 'all'>('all');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const strip = data ? stripSegments(data.timeline) : [];
  const maxWall = data
    ? Math.max(1, ...data.byStatus.map((s) => s.wallMs))
    : 1;
  const elapsedMs =
    data && data.timeline.length > 0
      ? Math.max(...data.timeline.map((s) => s.endMs)) -
        Math.min(...data.timeline.map((s) => s.startMs))
      : 0;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/20 animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        aria-label={data ? `${data.issueKey} detail` : 'Ticket detail'}
        className="fixed right-0 top-14 z-50 flex h-[calc(100%-3.5rem)] w-[29rem] max-w-full flex-col
                   border-l border-slate-200 bg-white shadow-dropdown animate-slide-in-right"
      >
        {/* ---------- header ---------- */}
        <div className="border-b border-slate-200 px-4 pb-3 pt-4">
          <div className="mb-2 flex items-center gap-2">
            {data?.issueType && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                <i
                  className="h-[7px] w-[7px] rounded-sm"
                  style={{ backgroundColor: '#14b8a6' }}
                  aria-hidden="true"
                />
                {data.issueType}
              </span>
            )}
            <span className="font-mono text-[13px] font-semibold text-indigo-700">
              {data?.issueKey ?? '…'}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              {data?.url ? (
                <a
                  href={data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-700"
                >
                  Open work item ↗
                </a>
              ) : (
                <span
                  className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-slate-400"
                  title="This source has no base URL recorded, so a deep link cannot be built."
                >
                  Open work item ↗
                </span>
              )}
              <button
                type="button"
                aria-label="close drawer"
                onClick={onClose}
                className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              >
                ✕
              </button>
            </div>
          </div>

          <h2 className="text-[15px] font-semibold leading-snug text-slate-900">
            {loading && !data ? (
              <span className="inline-block h-4 w-56 animate-pulse rounded bg-slate-100" />
            ) : (
              data?.title ?? <span className="text-slate-400">Untitled</span>
            )}
          </h2>

          {data?.epic && (
            <a
              href={data.epic.url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className={`mt-2.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-slate-200 bg-slate-100 py-1 pl-1.5 pr-2 text-[11.5px] text-slate-600 transition hover:border-indigo-300 hover:text-slate-800 ${
                data.epic.url ? '' : 'pointer-events-none'
              }`}
            >
              <i className="h-3 w-[3px] rounded-sm bg-purple-500" aria-hidden="true" />
              <span className="font-mono text-[11px] font-semibold">{data.epic.key}</span>
              {data.epic.title && <span className="truncate">{data.epic.title}</span>}
            </a>
          )}
        </div>

        {/* ---------- stat strip ---------- */}
        <dl className="grid grid-cols-4 border-b border-slate-200 bg-slate-50">
          <Stat label="Counted" value={formatHours(countedSeconds)} sub="on timesheet" />
          <Stat
            label="Sessions"
            value={data ? String(data.intervals.length) : '—'}
            sub="this period"
          />
          <Stat
            label="Opened"
            value={formatLocalDate(data?.openedAtMs ?? null)}
            title={formatUtcTooltip(data?.openedAtMs ?? null)}
          />
          <Stat
            label="Status"
            value={
              data?.currentStatus ? (
                <span className="inline-flex items-center gap-1.5 text-[12.5px]">
                  <i
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: statusTone(data.currentStatus) }}
                    aria-hidden="true"
                  />
                  {data.currentStatus}
                </span>
              ) : (
                '—'
              )
            }
            sub={data?.resolvedAtMs ? formatLocalDate(data.resolvedAtMs) : undefined}
          />
        </dl>

        <div className="flex-1 overflow-y-auto">
          {/* ---------- time in progress ---------- */}
          <section className={SECTION}>
            <div className="mb-3 flex items-center gap-2.5">
              <h3 className={SECTION_TITLE}>Time in progress</h3>
              <span className="ml-auto text-xs font-semibold tabular-nums text-slate-600">
                {formatDuration(data?.inProgressMs ?? 0)} of {formatDuration(elapsedMs)} elapsed
              </span>
            </div>

            {strip.length > 0 && (
              <>
                <div className="flex h-2.5 gap-px overflow-hidden rounded-full">
                  {strip.map((s, i) => (
                    <span
                      key={`${s.status}-${s.startMs}-${i}`}
                      className="block"
                      style={{
                        width: `${s.pct}%`,
                        backgroundColor: s.counted
                          ? '#14b8a6'
                          : /blocked|at risk/i.test(s.status)
                            ? 'rgba(226,68,92,.32)'
                            : '#e2e8f0',
                      }}
                      title={`${s.status} · ${formatDuration(s.endMs - s.startMs)}${s.counted ? ' · counted' : ''}`}
                    />
                  ))}
                </div>
                <div className="mt-1.5 flex justify-between text-[10.5px] tabular-nums text-slate-400">
                  <span>
                    {formatLocalDate(
                      data ? Math.min(...data.timeline.map((s) => s.startMs)) : null,
                    )}
                  </span>
                  <span>
                    {formatLocalDate(
                      data ? Math.max(...data.timeline.map((s) => s.endMs)) : null,
                    )}
                  </span>
                </div>
              </>
            )}

            {data && data.byStatus.length > 0 ? (
              <div className="mt-4 flex flex-col gap-0.5">
                {data.byStatus.map((row) => (
                  <StatusRow key={row.status} row={row} maxWall={maxWall} />
                ))}
              </div>
            ) : (
              !loading && (
                <p className="mt-3 text-xs text-slate-400">
                  No status history recorded for this ticket.
                </p>
              )
            )}
          </section>

          {/* ---------- details ---------- */}
          <section className={SECTION}>
            <h3 className={`${SECTION_TITLE} mb-3`}>Details</h3>
            <dl className="grid grid-cols-[88px_1fr] gap-x-3.5 gap-y-2.5">
              <Fact label="Reporter" value={data?.reporter} />
              <Fact label="Assignee" value={data?.assignee} />
              <Fact label="Priority" value={data?.priority} />
              <Fact
                label="Story points"
                value={data?.storyPoints == null ? null : String(data.storyPoints)}
              />
              <Fact label="Sprint" value={data?.sprint} />
              <Fact
                label="Resolved"
                value={data?.resolvedAtMs ? formatLocalDateTime(data.resolvedAtMs) : null}
              />
            </dl>
          </section>

          {/* ---------- activity ---------- */}
          <section className="px-4 py-4">
            <div className="mb-3 flex items-center gap-2.5">
              <h3 className={SECTION_TITLE}>Activity</h3>
              <div
                className="ml-auto inline-flex gap-0.5 rounded-lg border border-slate-200 bg-slate-100 p-0.5"
                role="group"
                aria-label="Filter activity"
              >
                {FILTERS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    aria-pressed={filter === f.value}
                    onClick={() => setFilter(f.value)}
                    className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition ${
                      filter === f.value
                        ? 'bg-white text-slate-800 shadow-card'
                        : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <ActivityFeed activity={activity} filter={filter} loading={loading} />
          </section>
        </div>
      </aside>
    </>
  );
}

function Stat({
  label,
  value,
  sub,
  title,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  title?: string;
}) {
  return (
    <div className="border-r border-slate-200 px-3.5 py-3 last:border-r-0">
      <dt className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
        {label}
      </dt>
      <dd
        className="truncate text-[15px] font-semibold tabular-nums text-slate-900"
        title={title || undefined}
      >
        {value}
        {sub && (
          <span className="mt-px block text-[11px] font-normal text-slate-500">{sub}</span>
        )}
      </dd>
    </div>
  );
}

function Fact({ label, value }: { label: string; value?: string | null }) {
  return (
    <>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-[12.5px] tabular-nums text-slate-700">
        {value ?? <span className="text-slate-400">—</span>}
      </dd>
    </>
  );
}

function StatusRow({ row, maxWall }: { row: StatusDurationDto; maxWall: number }) {
  return (
    <div className="grid grid-cols-[104px_1fr_62px] items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-slate-50">
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium text-slate-700">
        <i
          className="h-2 w-2 shrink-0 rounded-sm"
          style={{ backgroundColor: statusTone(row.status) }}
          aria-hidden="true"
        />
        <span className="truncate">{row.status}</span>
      </div>
      <div className="h-[7px] overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full ${row.counted ? 'bg-indigo-500' : 'bg-slate-300'}`}
          style={{ width: `${Math.max(2, (row.wallMs / maxWall) * 100)}%` }}
        />
      </div>
      <div
        className={`text-right text-[12.5px] tabular-nums ${
          row.counted ? 'font-semibold text-slate-800' : 'text-slate-400'
        }`}
      >
        {formatDuration(row.wallMs)}
      </div>
      <div className="col-start-2 col-end-4 -mt-0.5 text-[10.5px] tabular-nums text-slate-400">
        {row.visits === 1 ? '1 visit' : `${row.visits} visits`}
        {!row.counted && (
          <span className="ml-1.5 rounded border border-slate-200 bg-slate-100 px-1 py-px text-[9.5px] font-bold uppercase tracking-wide text-slate-400">
            not counted
          </span>
        )}
      </div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-xs leading-relaxed text-slate-600">
      <span
        className="mt-px grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-slate-300 text-[11px] font-bold text-white"
        aria-hidden="true"
      >
        i
      </span>
      <div>{children}</div>
    </div>
  );
}

function ActivityFeed({
  activity,
  filter,
  loading,
}: {
  activity: TicketActivityResult | null;
  filter: ActivityKind | 'all';
  loading: boolean;
}) {
  if (loading && activity === null) {
    return (
      <div className="flex flex-col gap-2.5" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-slate-100" />
        ))}
      </div>
    );
  }
  if (activity === null) return null;

  if (!activity.ok) {
    if (activity.reason === 'forbidden') {
      return (
        <Notice>
          Commits and pull requests need the{' '}
          <strong className="font-semibold">analytics role</strong>. Your access to this org tree
          covers hours only — ask an admin if you need the full activity trail.
        </Notice>
      );
    }
    if (activity.reason === 'unsupported-key') {
      // Structural, not configuration: commit and PR linking is keyed on
      // Jira-style keys, and an Azure DevOps work item has no such key to match.
      return (
        <Notice>
          Commit and pull-request linking is matched on Jira-style ticket keys, so it doesn&apos;t
          reach Azure DevOps work items. The status history above is complete.
        </Notice>
      );
    }
    return (
      <Notice>
        Couldn&apos;t load commit and pull-request activity just now. The hours above are
        unaffected.
      </Notice>
    );
  }

  const shown =
    filter === 'all'
      ? activity.events
      : activity.events.filter((e) => activityKind(e.source) === filter);

  if (activity.events.length === 0) {
    return (
      <Notice>
        No commits or pull requests are linked to this ticket. Commit linking matches the ticket key
        prefixes configured for the board.
      </Notice>
    );
  }
  if (shown.length === 0) {
    return <p className="text-xs text-slate-400">Nothing of that kind on this ticket.</p>;
  }

  return (
    <ol className="relative ml-1 border-l-2 border-slate-200 pl-5">
      {shown.map((e, i) => (
        <ActivityRow key={`${e.source}-${e.ref}-${i}`} event={e} />
      ))}
    </ol>
  );
}

function ActivityRow({ event }: { event: TicketTimelineEvent }) {
  const kind = activityKind(event.source);
  const ms = Date.parse(event.ts);
  const at = Number.isNaN(ms) ? event.ts : formatLocalDateTime(ms);
  return (
    <li className="relative pb-4 last:pb-0">
      <span
        className={`absolute -left-[26px] top-1 h-2.5 w-2.5 rounded-full border-2 bg-white ${KIND_DOT[kind]}`}
        aria-hidden="true"
      />
      <div className="mb-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-slate-400">
        <span className="rounded border border-slate-200 bg-slate-100 px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide text-slate-500">
          {SOURCE_LABEL[event.source] ?? event.source}
        </span>
        <time dateTime={event.ts} title={Number.isNaN(ms) ? undefined : formatUtcTooltip(ms)}>
          {at}
        </time>
        {kind === 'commit' && (
          <code className="rounded bg-slate-100 px-1 font-mono text-[11px] text-slate-500">
            {event.ref.slice(0, 7)}
          </code>
        )}
      </div>
      <div className="text-[12.5px] leading-snug text-slate-800">{event.title}</div>
      {event.actor && <div className="mt-0.5 text-[11px] text-slate-500">{event.actor}</div>}
    </li>
  );
}
