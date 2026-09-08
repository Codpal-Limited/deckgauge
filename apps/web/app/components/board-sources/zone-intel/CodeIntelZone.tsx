'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { AdoSourceRepositoryDto, AdoAreaPathDto } from '@deckgauge/shared';
import {
  fetchAdoSourceRepositories,
  saveAdoIntelligenceRepos,
  fetchAdoSourceAreaPaths,
  saveAdoIntelligenceAreaPaths,
} from '../../../actions/board-sources';

export interface ConnectionState {
  syncPrs: boolean;
  syncCommits: boolean;
  syncRepos?: string[]; // ADO only
  syncAllRepos?: boolean; // ADO only
  aiAssistDetectedPct?: number | null;
}

interface Props {
  useForIntelligence: boolean;
  onChange: (next: boolean) => void;
  connectionState: ConnectionState;
  lastSyncedAt: string | null;
  manageHref: string;
  // ADO only: when set, the PRs/Commits/repos scope is edited inline (persisted
  // to the shared project sync) instead of being read-only with a link out to
  // the Connections page. Requires `onConnectionChange`.
  editableConnection?: boolean;
  onConnectionChange?: (next: ConnectionState) => void;
  // ADO only: enables the per-board "Intelligence repositories" checkbox list
  // (Task 13). Requires boardId, sourceId AND onIntelligenceReposChange —
  // without all three the picker is omitted entirely, so non-ADO callers
  // (GitHub) are unaffected.
  boardId?: string;
  sourceId?: string;
  // Controlled current selection, owned by the CALLER (e.g. BoardSourceCard),
  // not by this component. Task 13 originally kept this as internal state
  // seeded once from props, but this zone unmounts whenever the parent card
  // collapses (BoardSourceCard renders it inside `{expanded && ...}`) — an
  // internal `useState` would silently re-seed from this stale prop on
  // re-expand, reverting a selection the user already saved. Lifting it here
  // keeps R10's "no revalidation, update immediately" behavior (toggling
  // still fires the save in the background without waiting on it) while
  // making the value itself survive the zone's own unmount/remount.
  intelligenceRepos?: string[];
  onIntelligenceReposChange?: (next: string[]) => void;
  // ADO only: enables the per-board "Area paths for analytics" checkbox list
  // (Task 9) — the `intelligenceRepos` counterpart for work items. Same
  // gating and controlled-value rules as `intelligenceRepos` above: requires
  // boardId, sourceId AND onIntelligenceAreaPathsChange, and is owned by the
  // caller so the selection survives this zone's unmount/remount.
  intelligenceAreaPaths?: string[];
  onIntelligenceAreaPathsChange?: (next: string[]) => void;
}

function parseRepos(text: string): string[] {
  return text
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

function dotClass(on: boolean) {
  return `inline-block w-1.5 h-1.5 rounded-full ${on ? 'bg-emerald-500' : 'bg-slate-300'}`;
}

function rowStateLabel(connectionOn: boolean, used: boolean) {
  if (!connectionOn) return 'Not enabled';
  return used ? 'Syncing' : 'Available (skipped)';
}

// Names every OTHER board attached to the same (shared) project sync, for the
// "changing this affects ... too" warning under EditableCodeSync. Returns
// null when there is nothing to say — no other board shares this sync — so
// the caller can omit the line entirely rather than print an empty list or a
// dangling "and .".
function formatOtherBoardsMessage(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `Changing this affects the ${names[0]} board too.`;
  const last = names[names.length - 1];
  const rest = names.slice(0, -1);
  return `Changing this affects the ${rest.join(', ')} and ${last} boards too.`;
}

type RepoPickerState =
  | { kind: 'loading' }
  | { kind: 'ready'; repos: AdoSourceRepositoryDto[]; otherBoardNames: string[] }
  | { kind: 'error' };

type AreaPathPickerState =
  | { kind: 'loading' }
  | { kind: 'ready'; areaPaths: AdoAreaPathDto[] }
  | { kind: 'error' };

export function CodeIntelZone({
  useForIntelligence,
  onChange,
  connectionState,
  lastSyncedAt,
  manageHref,
  editableConnection,
  onConnectionChange,
  boardId,
  sourceId,
  intelligenceRepos,
  onIntelligenceReposChange,
  intelligenceAreaPaths,
  onIntelligenceAreaPathsChange,
}: Props) {
  const anyAvailable = connectionState.syncPrs || connectionState.syncCommits;
  const used = useForIntelligence && anyAvailable;
  const editing = editableConnection === true && onConnectionChange !== undefined;
  // The picker (and the repo data it fetches) is enabled only when the caller
  // supplied all three of boardId/sourceId/onIntelligenceReposChange — same
  // gate as before, kept exact so a caller that omits the handler (e.g. a
  // read-only render) never triggers the fetch.
  const pickerEnabled = Boolean(boardId && sourceId && onIntelligenceReposChange);

  const [repoState, setRepoState] = useState<RepoPickerState>({ kind: 'loading' });

  const load = () => {
    if (!pickerEnabled || !boardId || !sourceId) return;
    setRepoState({ kind: 'loading' });
    fetchAdoSourceRepositories(boardId, sourceId)
      .then((res) => setRepoState({ kind: 'ready', repos: res.repos, otherBoardNames: res.otherBoardNames }))
      .catch(() => setRepoState({ kind: 'error' }));
  };

  useEffect(() => {
    if (pickerEnabled) load();
    // `load` intentionally omitted: it closes over nothing but
    // boardId/sourceId/pickerEnabled (recreated fresh each render) and
    // re-running this effect for it would refetch on every render.
  }, [boardId, sourceId, pickerEnabled]);

  const otherBoardNames = repoState.kind === 'ready' ? repoState.otherBoardNames : [];

  // Same gate as the repo picker, but keyed off `onIntelligenceAreaPathsChange`
  // — a caller that supplies the repos handler but not this one still gets
  // only the repo picker, never a half-wired area-path fetch.
  const areaPathsEnabled = Boolean(boardId && sourceId && onIntelligenceAreaPathsChange);

  const [areaPathState, setAreaPathState] = useState<AreaPathPickerState>({ kind: 'loading' });

  const loadAreaPaths = () => {
    if (!areaPathsEnabled || !boardId || !sourceId) return;
    setAreaPathState({ kind: 'loading' });
    fetchAdoSourceAreaPaths(boardId, sourceId)
      .then((res) => setAreaPathState({ kind: 'ready', areaPaths: res.areaPaths }))
      .catch(() => setAreaPathState({ kind: 'error' }));
  };

  useEffect(() => {
    if (areaPathsEnabled) loadAreaPaths();
    // `loadAreaPaths` intentionally omitted — see the identical note on the
    // repo picker's `load` effect above.
  }, [boardId, sourceId, areaPathsEnabled]);

  return (
    <div className={`rounded-lg border border-slate-200 p-3 ${used ? '' : 'bg-slate-50'}`}>
      <div className="text-[10px] uppercase tracking-wider font-bold text-cyan-700 mb-2 flex items-center gap-2">
        → INTELLIGENCE FEED
        {!anyAvailable && !editing && (
          <span className="text-[10px] text-slate-400 normal-case font-normal ml-auto">
            no code sync available on the connection
          </span>
        )}
      </div>

      <label
        className={`flex items-center gap-3 px-3 py-2 rounded-md border ${
          useForIntelligence ? 'bg-cyan-50 border-cyan-200' : 'bg-white border-slate-200'
        }`}
      >
        <input
          role="switch"
          type="checkbox"
          checked={useForIntelligence}
          disabled={!anyAvailable}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="font-semibold text-sm text-slate-900">Include code in Intelligence</span>
        <span
          className={`ml-auto text-xs ${
            useForIntelligence ? 'text-cyan-700 font-medium' : 'text-slate-500'
          }`}
        >
          {anyAvailable ? (useForIntelligence ? 'ON' : 'OFF') : 'unavailable'}
        </span>
      </label>

      {boardId && sourceId && onIntelligenceReposChange && (
        <IntelligenceRepoPicker
          boardId={boardId}
          sourceId={sourceId}
          selected={intelligenceRepos ?? []}
          onSelectedChange={onIntelligenceReposChange}
          state={repoState}
          onRetry={load}
          syncAllRepos={connectionState.syncAllRepos ?? false}
          syncRepos={connectionState.syncRepos ?? []}
        />
      )}

      {boardId && sourceId && onIntelligenceAreaPathsChange && (
        <IntelligenceAreaPathPicker
          boardId={boardId}
          sourceId={sourceId}
          selected={intelligenceAreaPaths ?? []}
          onSelectedChange={onIntelligenceAreaPathsChange}
          state={areaPathState}
          onRetry={loadAreaPaths}
        />
      )}

      {editing ? (
        <EditableCodeSync
          value={connectionState}
          onChange={onConnectionChange}
          otherBoardNames={otherBoardNames}
        />
      ) : (
        <div className="mt-2 space-y-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="w-28 text-slate-500">Pull requests</span>
            <span className={dotClass(used && connectionState.syncPrs)} />
            <span className="font-medium text-slate-900">
              {rowStateLabel(connectionState.syncPrs, used)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="w-28 text-slate-500">Commits</span>
            <span className={dotClass(used && connectionState.syncCommits)} />
            <span className="font-medium text-slate-900">
              {rowStateLabel(connectionState.syncCommits, used)}
            </span>
          </div>
          {connectionState.aiAssistDetectedPct != null && (
            <div className="flex items-center gap-2 text-xs">
              <span className="w-28 text-slate-500">AI-assist signal</span>
              <span className={dotClass(used)} />
              <span className="font-medium text-slate-900">
                Detected on {connectionState.aiAssistDetectedPct}% of PRs
              </span>
            </div>
          )}
          {connectionState.syncRepos && connectionState.syncRepos.length > 0 && (
            <div className="flex items-start gap-2 text-xs">
              <span className="w-28 text-slate-500">Repos</span>
              <span className="flex flex-wrap gap-1">
                {connectionState.syncRepos.map((r) => (
                  <span
                    key={r}
                    className="px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-700 text-[10px]"
                  >
                    {r}
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="mt-2 pt-2 border-t border-dashed border-slate-100 flex text-[11px] text-slate-400">
        {lastSyncedAt ? `Last code sync: ${lastSyncedAt}` : 'No sync yet'}
        <Link href={manageHref} className="ml-auto text-cyan-700 font-medium">
          manage in Connections ↗
        </Link>
      </div>
    </div>
  );
}

// ADO-only inline editor for the shared project sync's code-sync scope. Holds a
// local text buffer for the repo list so typing a comma isn't re-parsed
// mid-keystroke; parsed values are pushed up on every change.
function EditableCodeSync({
  value,
  onChange,
  otherBoardNames,
}: {
  value: ConnectionState;
  onChange: (next: ConnectionState) => void;
  // Every OTHER board attached to this same (shared) project sync. See
  // `formatOtherBoardsMessage`.
  otherBoardNames: string[];
}) {
  const [reposText, setReposText] = useState((value.syncRepos ?? []).join(', '));
  const allRepos = value.syncAllRepos ?? false;
  const otherBoardsMessage = formatOtherBoardsMessage(otherBoardNames);

  const toggle = (key: 'syncPrs' | 'syncCommits' | 'syncAllRepos', checked: boolean) =>
    onChange({ ...value, [key]: checked });

  return (
    <div className="mt-2 space-y-2">
      <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 flex items-center gap-2">
        Synced from Azure DevOps
        <span className="text-amber-600 normal-case font-normal">
          ⚠ shared by every board
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-1.5 text-slate-700">
          <input
            type="checkbox"
            checked={value.syncPrs}
            onChange={(e) => toggle('syncPrs', e.target.checked)}
          />
          Pull requests
        </label>
        <label className="flex items-center gap-1.5 text-slate-700">
          <input
            type="checkbox"
            checked={value.syncCommits}
            onChange={(e) => toggle('syncCommits', e.target.checked)}
          />
          Commits
        </label>
        <label className="flex items-center gap-1.5 text-slate-700">
          <input
            type="checkbox"
            checked={allRepos}
            onChange={(e) => toggle('syncAllRepos', e.target.checked)}
          />
          All repositories
        </label>
      </div>
      <input
        aria-label="Repositories"
        // While All repositories is checked, the stored list (still in
        // `sync_repos`) is completely ignored — showing it here, greyed out,
        // reads as "these are still synced" when they are not what governs
        // ingest any more. Clear the DISPLAYED value only; `reposText` itself
        // is untouched so unchecking brings the same names straight back.
        value={allRepos ? '' : reposText}
        disabled={allRepos}
        placeholder={
          allRepos
            ? 'Ignored while All repositories is on'
            : 'repo1, repo2 — leave blank to pick later'
        }
        onChange={(e) => {
          setReposText(e.target.value);
          onChange({ ...value, syncRepos: parseRepos(e.target.value) });
        }}
        className="w-full rounded border border-slate-300 px-2 py-1 text-xs disabled:bg-slate-100 disabled:text-slate-400"
      />
      {allRepos && (
        <p className="text-[10px] text-slate-400">
          All repositories in this project will be synced. The list above is ignored while this is
          on.
        </p>
      )}
      <p className="text-[10px] text-slate-400">
        Code-sync scope is shared — changes apply to every board using this Azure DevOps project.
      </p>
      {otherBoardsMessage && <p className="text-[10px] text-slate-500">{otherBoardsMessage}</p>}
    </div>
  );
}

// ADO-only: lets THIS board narrow which of the project's repositories its
// engineering-intelligence widgets show. Deliberately distinct from
// `EditableCodeSync`'s repo text field above, which governs what the worker
// INGESTS for every board sharing this connection — see the module doc on
// `SourceShape.intelligenceRepos` in BoardSourceCard.tsx. The two controls used
// to render with no label distinguishing them, which is why a user seeing the
// same repo names in both read it as a rendering bug — "SHOWN ON THIS BOARD"
// below and "SYNCED FROM AZURE DEVOPS" on EditableCodeSync name what each one
// actually does.
//
// Per Controller ruling R10 (task-13-brief.md): the save action does not
// revalidate, so nothing here waits on a server round-trip to reflect a
// toggle — `selected` is fully controlled by the caller (see the Props doc
// comment on `intelligenceRepos` for why it isn't internal state), and a
// toggle updates it synchronously via `onSelectedChange` before firing the
// save in the background.
function IntelligenceRepoPicker({
  boardId,
  sourceId,
  selected,
  onSelectedChange,
  state,
  onRetry,
  syncAllRepos,
  syncRepos,
}: {
  boardId: string;
  sourceId: string;
  selected: string[];
  onSelectedChange: (next: string[]) => void;
  state: RepoPickerState;
  onRetry: () => void;
  // Whether the shared project sync ingests every repo (`sync_all_repos`).
  // When true, EVERY row ingests — there is nothing stale to warn about, so
  // no row gets a badge. When false, only the historical (no-longer-synced)
  // rows are worth flagging.
  syncAllRepos: boolean;
  // The UNSAVED draft's `sync_repos` list — same source as `syncAllRepos`.
  // Deliberately NOT `r.syncing` (fetched once, on mount, from the last
  // SAVED scope): `EditableCodeSync` above edits this same connection as a
  // draft the user is still looking at, and the repo fetch never re-runs on
  // an edit. Computing the badge from the draft instead of the stale fetch
  // is what keeps this row honest the instant "All repositories" is
  // unchecked, rather than only after Save + collapse/re-expand or a reload.
  syncRepos: string[];
}) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const repos = state.kind === 'ready' ? state.repos : [];
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredRepos = useMemo(
    () =>
      normalizedFilter
        ? repos.filter((r) => r.repoName.toLowerCase().includes(normalizedFilter))
        : repos,
    [repos, normalizedFilter],
  );

  if (state.kind === 'loading') {
    return (
      <div
        role="status"
        aria-label="Loading repositories"
        className="mt-2 h-5 w-40 rounded bg-slate-100 animate-pulse"
      />
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="mt-2 text-xs text-slate-500">
        Couldn&apos;t load repositories.{' '}
        <button type="button" onClick={onRetry} className="text-cyan-700 hover:underline">
          Retry
        </button>
      </div>
    );
  }

  const toggle = (repoName: string, checked: boolean) => {
    const next = checked ? [...selected, repoName] : selected.filter((r) => r !== repoName);
    // Update the caller's state immediately (R10) — do not wait on the save
    // below, and clear any previous save error since this is a fresh attempt.
    setSaveError(null);
    onSelectedChange(next);
    saveAdoIntelligenceRepos(boardId, sourceId, next).catch(() => {
      // There is no revalidation path to reconcile against here, so the
      // optimistic selection stays on screen — but with nothing shown the
      // user would believe an unsaved choice was persisted. Surface it
      // instead of swallowing it.
      setSaveError("Couldn't save this selection. Your change is shown, but was not saved.");
    });
  };

  return (
    <div className="mt-2 space-y-1.5 rounded-md border border-slate-200 p-2">
      <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
        Shown on this board
      </div>
      <div className="flex items-center gap-2 text-xs">
        <input
          type="text"
          aria-label="Filter repositories"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 min-w-0 rounded border border-slate-300 px-2 py-1 text-xs"
        />
        <span className="text-slate-500 whitespace-nowrap">
          {selected.length} of {repos.length} selected
        </span>
      </div>
      {/* Always present, even unfiltered (where it equals the total) — the
          filter narrows which checkboxes are visible, and this says how many,
          so "N of M selected" above never has to double as a "shown" count
          and silently lie about what's on screen while filtering. */}
      <div className="text-[10px] text-slate-400">{filteredRepos.length} shown</div>
      <div className="space-y-1 max-h-40 overflow-auto">
        {filteredRepos.map((r) => (
          <label key={r.repoName} className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={selected.includes(r.repoName)}
              onChange={(e) => toggle(r.repoName, e.target.checked)}
            />
            <span>
              {r.repoName} ({r.prCount} PRs)
            </span>
            {/* A badge is a warning, not a status report. With
                syncAllRepos, every row ingests — nothing is stale, so no
                row is badged. Otherwise a row is historical only when the
                CURRENT draft's syncRepos omits it — computed from the draft
                rather than the once-fetched `r.syncing`, so unchecking "All
                repositories" (or editing the repo list) badges the newly-
                frozen rows immediately, with no refetch. */}
            {!syncAllRepos && !syncRepos.includes(r.repoName) && (
              <>
                {' '}
                <span className="text-slate-400">○ historical — no longer synced</span>
              </>
            )}
          </label>
        ))}
        {filteredRepos.length === 0 && normalizedFilter && (
          <p className="text-[10px] text-slate-400">No repositories match &quot;{filter}&quot;.</p>
        )}
        {filteredRepos.length === 0 && !normalizedFilter && (
          <p className="text-[10px] text-slate-400">No repositories synced yet.</p>
        )}
      </div>
      {selected.length === 0 ? (
        <p className="text-[10px] text-slate-400">
          None selected = all repositories in this project.
        </p>
      ) : (
        <p className="text-[10px] text-amber-600">
          Azure DevOps release pipelines are project-level, so deploy frequency and change
          failure rate still cover the whole project.
        </p>
      )}
      {saveError && (
        <p role="alert" className="text-[10px] text-rose-600">
          {saveError}
        </p>
      )}
    </div>
  );
}

// ADO-only: lets THIS board narrow which area paths its engineering-
// intelligence WORK-ITEM widgets show — the `IntelligenceRepoPicker`
// counterpart for work items. `intelligenceRepos` cannot do this job:
// `cockpit.ado_work_items` has no repository column at all, which is the
// whole reason this picker (Task 9) exists. The helper text below is the
// one place a user is told the two controls scope different things, so it
// stays close to word-for-word between this file and its doc comments.
//
// Same R10 "no revalidation, update immediately" rule as the repo picker:
// `selected` is fully controlled by the caller, and a toggle updates it
// synchronously before firing the save in the background.
function IntelligenceAreaPathPicker({
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
        className="mt-2 h-5 w-40 rounded bg-slate-100 animate-pulse"
      />
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="mt-2 text-xs text-slate-500">
        Couldn&apos;t load area paths.{' '}
        <button type="button" onClick={onRetry} className="text-cyan-700 hover:underline">
          Retry
        </button>
      </div>
    );
  }

  const toggle = (areaPath: string, checked: boolean) => {
    const next = checked ? [...selected, areaPath] : selected.filter((a) => a !== areaPath);
    setSaveError(null);
    onSelectedChange(next);
    saveAdoIntelligenceAreaPaths(boardId, sourceId, next).catch(() => {
      setSaveError("Couldn't save this selection. Your change is shown, but was not saved.");
    });
  };

  return (
    <div className="mt-2 space-y-1.5 rounded-md border border-slate-200 p-2">
      <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
        Area paths for analytics
      </div>
      {/* The whole point of this picker: repositories scope CODE metrics
          (IntelligenceRepoPicker above); area paths scope WORK ITEMS. Empty
          means all. */}
      <p className="text-[10px] text-slate-400">
        Empty means all area paths. Repositories scope code metrics; area paths scope work items.
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
