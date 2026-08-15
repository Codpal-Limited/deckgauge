'use client';
import { useEffect, useState } from 'react';
import { TypeChipPicker } from '../primitives/TypeChipPicker';
import { StatusMappingLink } from '../primitives/StatusMappingLink';
import { fetchSourceJiraIssueTypes } from '../../../actions/board-sources';
import type { BoardStatusOption } from '../StatusMappingEditor';

export interface JiraZoneValue {
  syncIssuesToBoard: boolean;
  targetGroupId: string | null;
  allowedIssueTypes: string[];
  jqlFilter: string | null;
  statusMapping: Record<string, string>;
}

interface Props {
  value: JiraZoneValue;
  groups: Array<{ id: string; name: string }>;
  onChange: (next: JiraZoneValue) => void;
  previewCount: number | null;
  boardId: string;
  sourceId: string;
  boardStatuses: BoardStatusOption[];
  onSaveStatusMapping: (mapping: Record<string, string>) => Promise<void>;
}

export function JiraBoardZone({
  value,
  groups,
  onChange,
  previewCount,
  boardId,
  sourceId,
  boardStatuses,
  onSaveStatusMapping,
}: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(value.jqlFilter !== null);

  const patch = <K extends keyof JiraZoneValue>(k: K, v: JiraZoneValue[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-[10px] uppercase tracking-wider font-bold text-indigo-700 mb-2">
        → BOARD CONTENT
      </div>

      <label className={`flex items-center gap-3 px-3 py-2 rounded-md border ${
        value.syncIssuesToBoard ? 'bg-indigo-50 border-indigo-200' : 'bg-white border-slate-200'
      }`}>
        <input
          role="switch"
          type="checkbox"
          checked={value.syncIssuesToBoard}
          onChange={(e) => patch('syncIssuesToBoard', e.target.checked)}
        />
        <span className="font-semibold text-sm text-slate-900">Sync issues to this board</span>
        <span className={`ml-auto text-xs ${value.syncIssuesToBoard ? 'text-indigo-700 font-medium' : 'text-slate-500'}`}>
          {value.syncIssuesToBoard ? 'ON' : 'OFF'}
        </span>
      </label>

      <div className={`mt-3 space-y-2 ${value.syncIssuesToBoard ? '' : 'opacity-50 pointer-events-none'}`}>
        <Row label="Target group">
          <select
            className="text-xs border border-slate-200 rounded-md px-2 py-1"
            value={value.targetGroupId ?? ''}
            onChange={(e) => patch('targetGroupId', e.target.value || null)}
          >
            <option value="">(none)</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </Row>
        {/* Draft-only, like every other field here: an empty `allowedIssueTypes`
            is what keeps a newly attached source inert, so persisting a chip on
            click would arm the sync while the target group and JQL filter were
            still unsaved — and the next sweep promotes the whole project into an
            auto-created group. Save changes writes the zone in one patch. */}
        <Row label="Issue types">
          <IssueTypeChipsBlock
            boardId={boardId}
            sourceId={sourceId}
            value={value.allowedIssueTypes}
            onChange={(next) => patch('allowedIssueTypes', next)}
          />
        </Row>
        <Row label="Status mapping">
          <StatusMappingLink
            mapping={value.statusMapping}
            boardId={boardId}
            sourceId={sourceId}
            provider="jira"
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
            ▸ Advanced filter (JQL)
            <span className="ml-auto text-[10px] text-slate-400 font-normal">optional · power user</span>
          </summary>
          <textarea
            className="mt-2 w-full text-xs font-mono bg-slate-50 border border-slate-200 rounded-md p-2"
            placeholder='e.g. project = ENG AND status = "In Progress"'
            value={value.jqlFilter ?? ''}
            onChange={(e) => patch('jqlFilter', e.target.value === '' ? null : e.target.value)}
            rows={3}
          />
        </details>

        {previewCount != null && (
          <div className="mt-2 text-xs text-indigo-700 bg-indigo-50 rounded-md px-3 py-1.5 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
            ~{previewCount} issues currently match this filter
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

function IssueTypeChipsBlock({
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
    fetchSourceJiraIssueTypes(boardId, sourceId)
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
        aria-label="Loading issue types"
        className="h-5 w-32 rounded bg-slate-100 animate-pulse"
      />
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="text-xs text-slate-500">
        Couldn&apos;t load issue types.{' '}
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
