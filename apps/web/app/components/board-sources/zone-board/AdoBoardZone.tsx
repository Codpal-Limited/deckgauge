'use client';
import { useEffect, useMemo, useState } from 'react';
import { TypeChipPicker } from '../primitives/TypeChipPicker';
import { StatusMappingLink } from '../primitives/StatusMappingLink';
import type { AdoAreaPathDto } from '@deckgauge/shared';
import {
  fetchSourceAdoWorkItemTypes,
  fetchAdoSourceAreaPaths,
  saveAdoAreaPaths,
} from '../../../actions/board-sources';
import type { BoardStatusOption } from '../StatusMappingEditor';

export interface AdoZoneValue {
  syncWorkItemsToBoard: boolean;
  targetGroupId: string | null;
  allowedWorkItemTypes: string[];
  wiqlFilter: string | null;
  statusMapping: Record<string, string>;
  // Which of the project's area paths reach this board — governs BOTH the
  // board's synced work-item cards and its engineering-intelligence widgets
  // (Task 6/9). Empty means all area paths. Lives on the draft object (rather
  // than a separate top-level prop, unlike `intelligenceRepos` on
  // BoardSourceCard) so a toggle in `AreaPathPicker` below can update it
  // synchronously through the zone's existing `onChange`/`patch` path — see
  // that component's doc comment for the R10 immediate-save rule this keeps.
  // The board's Save-changes button deliberately does NOT re-send this field:
  // AreaPathPicker persists it immediately, the same way the Intelligence
  // Feed zone's repository picker already does for `intelligenceRepos`.
  areaPaths: string[];
}

interface Props {
  value: AdoZoneValue;
  groups: Array<{ id: string; name: string }>;
  onChange: (next: AdoZoneValue) => void;
  previewCount: number | null;
  boardId: string;
  sourceId: string;
  boardStatuses: BoardStatusOption[];
  onSaveStatusMapping: (mapping: Record<string, string>) => Promise<void>;
}

export function AdoBoardZone({
  value,
  groups,
  onChange,
  previewCount,
  boardId,
  sourceId,
  boardStatuses,
  onSaveStatusMapping,
}: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(value.wiqlFilter !== null);
  const patch = <K extends keyof AdoZoneValue>(k: K, v: AdoZoneValue[K]) =>
    onChange({ ...value, [k]: v });

  const [areaPathState, setAreaPathState] = useState<AreaPathPickerState>({ kind: 'loading' });

  const loadAreaPaths = () => {
    setAreaPathState({ kind: 'loading' });
    fetchAdoSourceAreaPaths(boardId, sourceId)
      .then((res) => setAreaPathState({ kind: 'ready', areaPaths: res.areaPaths }))
      .catch(() => setAreaPathState({ kind: 'error' }));
  };

  useEffect(() => {
    loadAreaPaths();
    // `loadAreaPaths` intentionally omitted: it closes over nothing but
    // boardId/sourceId (recreated fresh each render) and re-running this
    // effect for it would refetch on every render.
  }, [boardId, sourceId]);

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-[10px] uppercase tracking-wider font-bold text-indigo-700 mb-2">
        → BOARD CONTENT
      </div>
      <label className={`flex items-center gap-3 px-3 py-2 rounded-md border ${
        value.syncWorkItemsToBoard ? 'bg-indigo-50 border-indigo-200' : 'bg-white border-slate-200'
      }`}>
        <input
          role="switch"
          type="checkbox"
          checked={value.syncWorkItemsToBoard}
          onChange={(e) => patch('syncWorkItemsToBoard', e.target.checked)}
        />
        <span className="font-semibold text-sm text-slate-900">Sync work items to this board</span>
        <span className={`ml-auto text-xs ${value.syncWorkItemsToBoard ? 'text-indigo-700 font-medium' : 'text-slate-500'}`}>
          {value.syncWorkItemsToBoard ? 'ON' : 'OFF'}
        </span>
      </label>

      {/* Area paths govern the board AND Intelligence (board-scope.ts reads
          areaPaths from every attached ADO source with no syncWorkItemsToBoard
          filter), so this row must stay live and reachable even while the
          toggle above is off — it is the only mouse-reachable control for a
          field that keeps affecting the widgets regardless of the toggle
          state. Kept outside the dimmed wrapper below, deliberately, and
          above the Advanced filter (WIQL) disclosure per the design doc. */}
      <div className="mt-3">
        <Row label="Area paths">
          <AreaPathPicker
            boardId={boardId}
            sourceId={sourceId}
            selected={value.areaPaths}
            onSelectedChange={(next) => patch('areaPaths', next)}
            state={areaPathState}
            onRetry={loadAreaPaths}
          />
        </Row>
      </div>

      <div className={`mt-3 space-y-2 ${value.syncWorkItemsToBoard ? '' : 'opacity-50 pointer-events-none'}`}>
        <Row label="Target group">
          <select
            className="text-xs border border-slate-200 rounded-md px-2 py-1"
            value={value.targetGroupId ?? ''}
            onChange={(e) => patch('targetGroupId', e.target.value || null)}
          >
            <option value="">(none)</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Row>
        <Row label="Work item types">
          <WorkItemTypeChipsBlock
            boardId={boardId}
            sourceId={sourceId}
            value={value.allowedWorkItemTypes}
            onChange={(next) => patch('allowedWorkItemTypes', next)}
          />
        </Row>
        <Row label="Status mapping">
          <StatusMappingLink
            mapping={value.statusMapping}
            boardId={boardId}
            sourceId={sourceId}
            provider="ado"
            boardStatuses={boardStatuses}
            onChange={(m) => patch('statusMapping', m)}
            onSave={onSaveStatusMapping}
          />
        </Row>

        <details
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
          className="border-t border-dashed border-slate-100 pt-2"
        >
          <summary className="text-xs text-indigo-700 cursor-pointer font-medium flex items-center">
            ▸ Advanced filter (WIQL)
            <span className="ml-auto text-[10px] text-slate-400 font-normal">optional · power user</span>
          </summary>
          <textarea
            className="mt-2 w-full text-xs font-mono bg-slate-50 border border-slate-200 rounded-md p-2"
            placeholder="AND [System.AreaPath] UNDER 'Platform\\Payments'"
            value={value.wiqlFilter ?? ''}
            onChange={(e) => patch('wiqlFilter', e.target.value === '' ? null : e.target.value)}
            rows={3}
          />
        </details>

        {previewCount != null && (
          <div className="mt-2 text-xs text-indigo-700 bg-indigo-50 rounded-md px-3 py-1.5 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
            ~{previewCount} work items currently match this filter
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 items-center text-xs">
      <span className="text-slate-500 text-[11px]">{label}</span>
      <div>{children}</div>
    </div>
  );
}

function WorkItemTypeChipsBlock({
  boardId,
  sourceId,
  value,
  onChange,
}: {
  boardId: string;
  sourceId: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; options: string[] }
    | { kind: 'error' }
  >({ kind: 'loading' });

  const load = () => {
    setState({ kind: 'loading' });
    fetchSourceAdoWorkItemTypes(boardId, sourceId)
      .then((res) => setState({ kind: 'ready', options: res.types }))
      .catch(() => setState({ kind: 'error' }));
  };

  useEffect(() => {
    load();
  }, [boardId, sourceId]);

  if (state.kind === 'loading') {
    return (
      <div
        role="status"
        aria-label="Loading work-item types"
        className="h-5 w-32 rounded bg-slate-100 animate-pulse"
      />
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="text-xs text-slate-500">
        Couldn&apos;t load work-item types.{' '}
        <button
          type="button"
          onClick={load}
          className="text-indigo-600 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }
  // Merge live options with stale values so existing config never silently disappears.
  const merged = Array.from(new Set([...state.options, ...value])).sort();
  return <TypeChipPicker options={merged} value={value} onChange={onChange} />;
}

type AreaPathPickerState =
  | { kind: 'loading' }
  | { kind: 'ready'; areaPaths: AdoAreaPathDto[] }
  | { kind: 'error' };

// Lets THIS board narrow which of the project's area paths reach it — moved
// here from the Intelligence Feed zone (renamed from
// `IntelligenceAreaPathPicker`), because area paths scope the board's synced
// work-item CARDS as well as its engineering-intelligence widgets, not
// analytics alone. `intelligenceRepos` (the Intelligence Feed zone's
// repository picker) cannot do this job: `cockpit.ado_work_items` has no
// repository column at all, which is the whole reason this picker exists.
//
// Same R10 "no revalidation, update immediately" rule as the repository
// picker: `selected` (here, `value.areaPaths`) is fully controlled by the
// caller and a toggle updates it synchronously — via the zone's `onChange`/
// `patch`, so `value.areaPaths` reflects the tick before the fetch below even
// starts — before firing the save in the background.
//
// Area paths are used verbatim: never trim, normalise, case-fold or split
// one, here or in the save payload. The worker and ClickHouse both compare
// these strings with a plain `startsWith`, so any transformation here would
// silently desynchronise the board from the widgets.
function AreaPathPicker({
  boardId,
  sourceId,
  selected,
  onSelectedChange,
  state,
  onRetry,
}: {
  boardId: string;
  sourceId: string;
  selected: string[];
  onSelectedChange: (next: string[]) => void;
  state: AreaPathPickerState;
  onRetry: () => void;
}) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const areaPaths = state.kind === 'ready' ? state.areaPaths : [];
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredAreaPaths = useMemo(
    () =>
      normalizedFilter
        ? areaPaths.filter((a) => a.areaPath.toLowerCase().includes(normalizedFilter))
        : areaPaths,
    [areaPaths, normalizedFilter],
  );

  if (state.kind === 'loading') {
    return (
      <div
        role="status"
        aria-label="Loading area paths"
        className="h-5 w-40 rounded bg-slate-100 animate-pulse"
      />
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="text-xs text-slate-500">
        Couldn&apos;t load area paths.{' '}
        <button type="button" onClick={onRetry} className="text-indigo-600 hover:underline">
          Retry
        </button>
      </div>
    );
  }

  const toggle = (areaPath: string, checked: boolean) => {
    const next = checked ? [...selected, areaPath] : selected.filter((a) => a !== areaPath);
    // Update the caller's state immediately (R10) — do not wait on the save
    // below, and clear any previous save error since this is a fresh attempt.
    setSaveError(null);
    onSelectedChange(next);
    saveAdoAreaPaths(boardId, sourceId, next).catch(() => {
      // There is no revalidation path to reconcile against here, so the
      // optimistic selection stays on screen — but with nothing shown the
      // user would believe an unsaved choice was persisted. Surface it
      // instead of swallowing it.
      setSaveError("Couldn't save this selection. Your change is shown, but was not saved.");
    });
  };

  return (
    <div className="space-y-1.5 rounded-md border border-slate-200 p-2">
      <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
        Which work is this board&apos;s
      </div>
      <p className="text-[10px] text-slate-400">
        Empty means all. Selecting a path includes everything beneath it. Applies to the board and
        to Intelligence.
      </p>
      <div className="flex items-center gap-2 text-xs">
        <input
          type="text"
          aria-label="Filter area paths"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 min-w-0 rounded border border-slate-300 px-2 py-1 text-xs"
        />
        <span className="text-slate-500 whitespace-nowrap">
          {selected.length} of {areaPaths.length} selected
        </span>
      </div>
      <div className="text-[10px] text-slate-400">{filteredAreaPaths.length} shown</div>
      <div className="space-y-1 max-h-40 overflow-auto">
        {filteredAreaPaths.map((a) => (
          <label key={a.areaPath} className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={selected.includes(a.areaPath)}
              onChange={(e) => toggle(a.areaPath, e.target.checked)}
            />
            <span>
              {a.areaPath} ({a.workItemCount} work items)
            </span>
          </label>
        ))}
        {filteredAreaPaths.length === 0 && normalizedFilter && (
          <p className="text-[10px] text-slate-400">No area paths match &quot;{filter}&quot;.</p>
        )}
        {filteredAreaPaths.length === 0 && !normalizedFilter && (
          <p className="text-[10px] text-slate-400">No area paths with work items yet.</p>
        )}
      </div>
      {saveError && (
        <p role="alert" className="text-[10px] text-rose-600">
          {saveError}
        </p>
      )}
    </div>
  );
}
