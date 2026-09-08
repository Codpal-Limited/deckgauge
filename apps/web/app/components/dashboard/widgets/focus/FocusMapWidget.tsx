'use client';
import { useWidgetConfigWithBoardPeriod } from '../../useWidgetConfigWithBoardPeriod';
import { useWidgetData } from '../useWidgetData';
import { WidgetErrorState } from '../WidgetErrorState';
import { WidgetEmptyState } from '../WidgetEmptyState';
import {
  FocusNoData,
  CLASS_COLOR,
  CLASS_KEYS,
  WidgetLoading,
  type FocusClassKey,
} from './focus-ui';

interface Props {
  boardId: string;
  config: Record<string, unknown>;
}

interface Task {
  taskKey: string;
  title: string;
  cls: FocusClassKey;
  epicKey: string | null;
  owner: string | null;
  attentionDays: number;
  movesInWindow: number;
}

interface MapData {
  tasks: Task[];
  people: { name: string }[];
  epics: { key: string; title: string; touched: boolean; tasks: number }[];
  taskCount?: number;
  sourcesLastSyncedAt?: string | null;
  emptyReason?: string;
}

interface Cell {
  moved: number;
  parked: number;
  tasks: number;
}

const BOX = 30;

/**
 * Person × work-area matrix, one scale, one unit.
 *
 * Four cell states, and the third is the one that earns the widget:
 *
 *   filled  — days on tasks that moved
 *   hatched — days in a working state with NO state change in the window
 *   ring    — owned, zero days
 *   dot     — nothing
 *
 * A task accrues days whether or not anyone touched it, so a large hatched cell
 * is a large amount of nothing happening. On the reference data the single
 * biggest cell on the map was exactly that: 89 days on two tickets that never
 * moved. No stacked bar or funnel shows it.
 *
 * The roadmap columns share a scale with the OPEX columns deliberately. They
 * render small because they WERE small; giving them their own scale would
 * flatter them.
 */
export function FocusMapWidget({ boardId, config }: Props) {
  const merged = useWidgetConfigWithBoardPeriod(config);
  const { data, error } = useWidgetData<MapData>(boardId, 'FOCUS_MAP', merged);

  if (error) return <WidgetErrorState />;
  if (!data) return <WidgetLoading />;
  if (data.emptyReason) return <WidgetEmptyState boardId={boardId} reason={data.emptyReason} />;

  const people = [
    ...new Set(data.tasks.map((t) => t.owner).filter((o): o is string => o !== null)),
  ].sort();
  if (people.length === 0) return <FocusNoData {...data} />;

  const touchedEpics = data.epics.filter((e) => e.touched);
  // Typed as a total record over the class keys ON PURPOSE. This list used to be
  // three hand-written entries; adding class D left a task with nowhere to
  // render while line 82 still admitted it into `cells`, so it was invisible AND
  // inflated `max` — shrinking every visible box (one measured at 4.7px against
  // a 30px BOX). A total record makes the next class a compile error instead.
  const CLASS_COLUMN_LABEL: Record<FocusClassKey, string> = {
    A: 'Roadmap (no epic)',
    B: 'Opex',
    C: 'Internal',
    UNCLASSIFIED: 'Unclassified',
  };

  const columns: { key: string; label: string; color: string }[] = [
    ...touchedEpics.map((e) => ({ key: `epic:${e.key}`, label: e.key, color: CLASS_COLOR.A })),
    ...CLASS_KEYS.map((c) => ({
      key: `class:${c}`,
      label: CLASS_COLUMN_LABEL[c],
      color: CLASS_COLOR[c],
    })),
  ];

  const cells = new Map<string, Cell>();
  for (const t of data.tasks) {
    // Unowned work is skipped because there is nobody to attribute it to.
    // Unclassified work is NOT skipped any more (R6.4): it has a column of its
    // own, so a person whose work nobody has classified reports days instead of
    // an empty row that reads as idleness.
    if (!t.owner) continue;
    // Roadmap work the classifier could not pin to an epic gets its own column
    // rather than being dropped. Silently discarding it made the map's row
    // totals disagree with every other widget on the page.
    const column =
      t.epicKey && touchedEpics.some((e) => e.key === t.epicKey)
        ? `epic:${t.epicKey}`
        : `class:${t.cls}`;

    const id = `${t.owner}|${column}`;
    const cell = cells.get(id) ?? { moved: 0, parked: 0, tasks: 0 };
    cell.tasks += 1;
    if (t.movesInWindow > 0) cell.moved += t.attentionDays;
    else cell.parked += t.attentionDays;
    cells.set(id, cell);
  }

  const max = Math.max(1, ...[...cells.values()].map((c) => Math.max(c.moved, c.parked)));
  const side = (v: number) => (v <= 0 ? 0 : Math.max(4, Math.sqrt(v / max) * BOX));
  const label = (v: number) => (v < 1 ? '<1' : String(Math.round(v)));

  return (
    <div className="h-full flex flex-col gap-3">
      <div className="flex-1 overflow-auto">
        <div className="min-w-max">
          {/* A div matrix, so the header row itself is the sticky box — no
              border-collapse to work around here. It still needs the rule the
              scorecard's header carries: the cell grid's own `border-r` lines
              run up to the band and terminate invisibly inside it, so without
              an edge the frozen labels float over the matrix. */}
          <div className="sticky top-0 z-10 bg-white shadow-[inset_0_-1px_0_theme(colors.slate.200)] flex text-[10px] font-semibold uppercase tracking-wide">
            <div className="w-40 shrink-0" />
            {columns.map((c) => (
              <div
                key={c.key}
                className="w-[62px] shrink-0 text-center pb-2 leading-tight"
                style={{ color: c.color }}
              >
                {c.label}
              </div>
            ))}
          </div>
          {people.map((name) => (
            <div key={name} className="flex items-stretch">
              <div className="w-40 shrink-0 pr-3 h-14 flex items-center justify-end text-right border-b border-slate-100">
                <span className="text-[13px] font-medium text-slate-700">{name}</span>
              </div>
              {columns.map((c) => {
                const cell = cells.get(`${name}|${c.key}`);
                // A cell can hold both. Draw whichever is LARGER and name both
                // in the label — showing parked whenever any exists hid a
                // person's real work behind a single stale day.
                const parked = !!cell && cell.parked > cell.moved;
                const value = cell ? Math.max(cell.moved, cell.parked) : 0;
                const size = side(value);
                const title = !cell
                  ? 'nothing'
                  : cell.parked > 0 && cell.moved > 0
                    ? `${cell.tasks} task(s) · ${label(cell.moved)} days worked, ${label(cell.parked)} days parked without moving`
                    : parked
                      ? `${cell.tasks} task(s) · ${label(cell.parked)} days in a working state · never moved`
                      : `${cell.tasks} task(s) · ${label(cell.moved)} days`;

                return (
                  <div
                    key={c.key}
                    title={title}
                    aria-label={`${name}, ${c.label}: ${title}`}
                    className="w-[62px] h-14 shrink-0 relative flex items-start justify-center pt-2 border-r border-b border-slate-100"
                  >
                    {!cell ? (
                      <span className="text-slate-300 self-center -mt-2">·</span>
                    ) : size === 0 ? (
                      <span
                        className="w-3 h-3 rounded-sm border-[1.5px] opacity-60"
                        style={{ borderColor: c.color }}
                      />
                    ) : (
                      <>
                        <span
                          style={
                            parked
                              ? {
                                  width: size,
                                  height: size,
                                  borderRadius: 3,
                                  background: `repeating-linear-gradient(45deg, ${CLASS_COLOR.B} 0 2px, transparent 2px 5px)`,
                                  outline: `1.5px solid ${CLASS_COLOR.B}`,
                                  outlineOffset: -1,
                                }
                              : { width: size, height: size, borderRadius: 3, background: c.color }
                          }
                        />
                        <span
                          className="absolute bottom-0.5 inset-x-0 text-center text-[10px] tabular-nums"
                          style={{ color: parked ? CLASS_COLOR.B : '#94a3b8' }}
                        >
                          {label(value)}
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500 pt-2 border-t border-slate-100">
        <span className="flex items-center gap-1.5">
          <i
            aria-hidden
            className="w-3 h-3 rounded-sm inline-block"
            style={{ background: CLASS_COLOR.A }}
          />
          days on tasks that moved
        </span>
        <span className="flex items-center gap-1.5">
          <i
            aria-hidden
            className="w-3 h-3 rounded-sm inline-block"
            style={{
              background: `repeating-linear-gradient(45deg, ${CLASS_COLOR.B} 0 2px, transparent 2px 5px)`,
              outline: `1.5px solid ${CLASS_COLOR.B}`,
              outlineOffset: -1,
            }}
          />
          in a working state, never moved
        </span>
        <span className="flex items-center gap-1.5">
          <i aria-hidden className="w-3 h-3 rounded-sm border-[1.5px] border-slate-300 inline-block" />
          owned, zero days
        </span>
        <span className="ml-auto text-slate-400">Square area = days · one scale</span>
      </div>
    </div>
  );
}
