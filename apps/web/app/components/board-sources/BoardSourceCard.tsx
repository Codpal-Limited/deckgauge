'use client';
import { useState } from 'react';
import { CodeIntelZone, type ConnectionState } from './zone-intel/CodeIntelZone';
import { GitHubBoardZone, type GitHubZoneValue } from './zone-board/GitHubBoardZone';
import { AdoBoardZone, type AdoZoneValue } from './zone-board/AdoBoardZone';
import { JiraBoardZone, type JiraZoneValue } from './zone-board/JiraBoardZone';
import { GitLabBoardZone, type GitLabZoneValue } from './zone-board/GitLabBoardZone';
import type { BoardStatusOption } from './StatusMappingEditor';
import { FieldMappingEditor } from './FieldMappingEditor';
import { TokenRefreshBox } from '../connections/TokenRefreshBox';
import { TokenTutorial } from './providers/TokenTutorial';
import { ExcludedItemsBlock } from './ExcludedItemsBlock';
import {
  refreshJiraToken,
  refreshGitHubToken,
  refreshAdoToken,
  refreshGitLabToken,
} from '../../actions/connections';
import { ORG_ADMIN_REQUIRED_TO_RECONNECT } from '../../lib/connection-permission';
import type { SourceHealth } from '../../actions/board-sync';

const HEALTH_BADGE: Record<SourceHealth, { label: string; cls: string }> = {
  valid: { label: 'Valid', cls: 'bg-emerald-100 text-emerald-700' },
  expired: { label: 'Expired', cls: 'bg-rose-100 text-rose-700' },
  // The token still works — its single sign-on session is what lapsed, so the
  // remedy is authorizing it again, not replacing it.
  reauthorize: { label: 'Reauthorize', cls: 'bg-amber-100 text-amber-700' },
  unreachable: { label: 'Unreachable', cls: 'bg-amber-100 text-amber-700' },
};

const REFRESH_BY_PROVIDER = {
  jira: refreshJiraToken,
  github: refreshGitHubToken,
  ado: refreshAdoToken,
  gitlab: refreshGitLabToken,
} as const;

export type ProviderName = 'jira' | 'github' | 'ado' | 'gitlab';

type SourceCommon = {
  id: string;
  name: string;
  instanceId: string;
  lastSyncedAt: string | null;
};

export type SourceShape =
  | (SourceCommon & {
      provider: 'jira';
      zoneValue: JiraZoneValue;
      // fieldId -> columnId, for fields already synced into a board column.
      // Excludes those already-mapped fields from FieldMappingEditor's picker.
      fieldMappings: Record<string, string>;
    })
  | (SourceCommon & {
      provider: 'github';
      syncIssuesToBoard: boolean;
      useForIntelligence: boolean;
      zoneValue: GitHubZoneValue;
      connection: ConnectionState;
    })
  | (SourceCommon & {
      provider: 'ado';
      // Id of the shared AzureDevOpsProjectSync this board source references —
      // the PATCH target for the inline code-sync editor.
      azureDevOpsProjectSyncId: string;
      syncWorkItemsToBoard: boolean;
      useForIntelligence: boolean;
      zoneValue: AdoZoneValue;
      connection: ConnectionState;
    })
  | (SourceCommon & { provider: 'gitlab'; zoneValue: GitLabZoneValue });

// The ADO code-sync scope lives on the shared project sync, not the board
// source, so it is persisted through a separate patch than the board-source fields.
export interface AdoConnectionPatch {
  syncPrs: boolean;
  syncCommits: boolean;
  syncRepos: string[];
  syncAllRepos: boolean;
}

/** What the post-save sync reports back, rendered inline under the card's zones. */
export interface SourceSyncOutcome {
  kind: 'success' | 'error' | 'info';
  text: string;
}

type SavePhase = 'idle' | 'saving' | 'syncing';

interface Props {
  boardId: string;
  source: SourceShape;
  groups: Array<{ id: string; name: string }>;
  boardStatuses: BoardStatusOption[];
  // `connectionPatch` (ADO only) carries the shared project sync's code-sync
  // scope; the parent persists it separately from the board-source `patch`.
  onSave: (
    patch: Record<string, unknown>,
    connectionPatch?: AdoConnectionPatch
  ) => Promise<void> | void;
  // Persists a status-mapping change without bundling the card's other
  // unsaved draft fields. Owned by BoardSourcesList so the in-memory sources
  // list re-hydrates alongside the patch. Unused for GitLab cards (no
  // status-mapping zone) but still required to keep the prop contract simple.
  onSaveStatusMapping: (mapping: Record<string, string>) => Promise<void>;
  // Runs a board sync once the patch is persisted, so a settings change shows up
  // on the board without a manual sync or a page reload. Optional: a card can be
  // rendered without one, in which case saving just confirms itself.
  onSyncAfterSave?: () => Promise<SourceSyncOutcome>;
  // Called when a Jira field mapping is removed via FieldMappingEditor, so
  // the parent can refresh server data without a full board sync — the
  // column that field populated already exists and isn't touched by a
  // detach, so `onSyncAfterSave`'s sync + poll would be pure waste (and
  // would wrongly disable Save/Cancel and show a "synced" banner for a
  // change the user never pressed Save for). Optional for the same reason
  // `onSyncAfterSave` is: a card can render without either.
  onFieldUnmapped?: () => void;
  onDetach: () => Promise<void> | void;
  health?: SourceHealth;
  openFix?: boolean;
  /**
   * Whether the viewer may rotate this connection's token. Rotating is
   * orgRole(ADMIN); the health badge is not gated, only the fix.
   *
   * Defaults to `true`: this is presentation, the API is the enforcement point,
   * and the board Sources page — the only place this card is rendered — always
   * passes the viewer's real role.
   */
  canManageConnections?: boolean;
}

function BadgeFor({ provider }: { provider: ProviderName }) {
  const map: Record<ProviderName, { bg: string; label: string }> = {
    jira: { bg: 'bg-blue-700', label: 'J' },
    github: { bg: 'bg-[#0f172a]', label: 'GH' },
    ado: { bg: 'bg-sky-600', label: 'A' },
    gitlab: { bg: 'bg-orange-600', label: 'GL' },
  };
  const { bg, label } = map[provider];
  return (
    <span
      className={`rounded-md ${bg} text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0`}
      style={{ width: 22, height: 22 }}
    >
      {label}
    </span>
  );
}

function CollapsedChips({ source }: { source: SourceShape }) {
  const chips: Array<{ label: string; tone: 'on' | 'off' | 'intel' }> = [];
  switch (source.provider) {
    case 'github':
      chips.push({
        label: source.syncIssuesToBoard ? 'issues' : 'no issues',
        tone: source.syncIssuesToBoard ? 'on' : 'off',
      });
      chips.push({
        label: source.useForIntelligence ? 'code' : 'code skipped',
        tone: source.useForIntelligence ? 'intel' : 'off',
      });
      break;
    case 'ado':
      chips.push({
        label: source.syncWorkItemsToBoard ? 'work items' : 'no work items',
        tone: source.syncWorkItemsToBoard ? 'on' : 'off',
      });
      chips.push({
        label: source.useForIntelligence ? 'code' : 'code skipped',
        tone: source.useForIntelligence ? 'intel' : 'off',
      });
      break;
    case 'jira':
      chips.push({ label: 'issues', tone: 'on' });
      break;
    case 'gitlab':
      chips.push({ label: 'gitlab items', tone: 'on' });
      break;
  }
  return (
    <div className="flex gap-1 ml-auto">
      {chips.map((c, i) => (
        <span
          key={i}
          className={`text-[10px] px-1.5 py-0.5 rounded ${
            c.tone === 'on'
              ? 'bg-indigo-50 text-indigo-700'
              : c.tone === 'intel'
                ? 'bg-cyan-50 text-cyan-700'
                : 'bg-slate-100 text-slate-500'
          }`}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

export function BoardSourceCard({
  boardId,
  source,
  groups,
  boardStatuses,
  onSave,
  onSaveStatusMapping,
  onSyncAfterSave,
  onFieldUnmapped,
  onDetach,
  health,
  openFix,
  canManageConnections = true,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(source.zoneValue);
  const [draftUseForIntelligence, setDraftUFI] = useState<boolean>(
    source.provider === 'github' || source.provider === 'ado' ? source.useForIntelligence : false
  );
  // ADO only: editable draft of the shared project sync's code-sync scope.
  const [draftConnection, setDraftConnection] = useState<ConnectionState>(
    source.provider === 'ado' ? source.connection : { syncPrs: false, syncCommits: false }
  );
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<SavePhase>('idle');
  const [outcome, setOutcome] = useState<SourceSyncOutcome | null>(null);

  const issuesOn =
    (source.provider === 'github' && (draft as GitHubZoneValue).syncIssuesToBoard) ||
    (source.provider === 'ado' && (draft as AdoZoneValue).syncWorkItemsToBoard) ||
    source.provider === 'jira' ||
    (source.provider === 'gitlab' &&
      ((draft as GitLabZoneValue).syncIssuesToBoard || (draft as GitLabZoneValue).syncMrsToBoard));

  const codeOn =
    (source.provider === 'github' || source.provider === 'ado') && draftUseForIntelligence;

  async function handleSave() {
    if (!issuesOn && !codeOn) {
      setError(
        'At least one of issues/code must be enabled. Detach the source if you do not want either.'
      );
      return;
    }
    setError(null);
    setOutcome(null);
    const patch: Record<string, unknown> = { ...draft };
    if (source.provider === 'github' || source.provider === 'ado') {
      patch.useForIntelligence = draftUseForIntelligence;
    }
    const connectionPatch: AdoConnectionPatch | undefined =
      source.provider === 'ado'
        ? {
            syncPrs: draftConnection.syncPrs,
            syncCommits: draftConnection.syncCommits,
            syncRepos: draftConnection.syncRepos ?? [],
            syncAllRepos: draftConnection.syncAllRepos ?? false,
          }
        : undefined;
    setPhase('saving');
    try {
      await onSave(patch, connectionPatch);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save these settings.');
      setPhase('idle');
      return;
    }

    // Persisting is only half of what the user asked for: the board reads its rows
    // from a cached server render, so without a sync (and the cache drop it does)
    // the change is invisible until a full reload.
    if (!onSyncAfterSave) {
      setPhase('idle');
      setOutcome({ kind: 'success', text: 'Saved' });
      return;
    }

    setPhase('syncing');
    try {
      setOutcome(await onSyncAfterSave());
    } catch (e) {
      setOutcome({
        kind: 'error',
        text: e instanceof Error ? e.message : 'Saved, but the sync could not be started.',
      });
    } finally {
      setPhase('idle');
    }
  }

  // FieldMappingEditor's attach/detach are their own immediate writes, not
  // part of the draft-then-Save flow above — and the two need different
  // follow-ups. Attaching creates an empty column that is invisible until a
  // sync populates it, so it reuses the same post-write sync + outcome
  // banner the Save flow uses. Detaching only removes a mapping; the column
  // it produced (and its values) is untouched, so there is nothing for a
  // sync to populate — running one anyway would be pure waste, and sharing
  // `phase` with it would wrongly disable Save/Cancel for the sync's ~30s
  // poll and show a "synced" banner for a change the user never pressed Save
  // for. Detach instead asks the parent for a plain data refresh.
  async function handleFieldMappingChange(kind: 'attach' | 'detach') {
    if (kind === 'detach') {
      onFieldUnmapped?.();
      return;
    }
    if (!onSyncAfterSave) return;
    setOutcome(null);
    setPhase('syncing');
    try {
      setOutcome(await onSyncAfterSave());
    } catch (e) {
      setOutcome({
        kind: 'error',
        text: e instanceof Error ? e.message : 'Field updated, but the sync could not be started.',
      });
    } finally {
      setPhase('idle');
    }
  }

  const saveLabel = phase === 'saving' ? 'Saving…' : phase === 'syncing' ? 'Syncing…' : 'Save changes';

  return (
    <div
      className={`rounded-lg border ${expanded ? 'border-indigo-500 shadow-md' : 'border-slate-200'} bg-white overflow-hidden mb-2`}
    >
      <button
        type="button"
        aria-label={expanded ? 'Collapse' : 'Expand'}
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left flex items-center gap-2 px-3 py-2"
      >
        <BadgeFor provider={source.provider} />
        <span className="font-mono text-sm font-medium text-slate-900">{source.name}</span>
        {health && (
          <span
            className={`ml-2 rounded px-2 py-0.5 text-xs font-medium ${HEALTH_BADGE[health].cls}`}
          >
            {HEALTH_BADGE[health].label}
          </span>
        )}
        <CollapsedChips source={source} />
      </button>

      {(openFix || (health && health !== 'valid')) && (
        <div className="px-3 pb-3 space-y-2">
          {canManageConnections ? (
            <>
              <TokenTutorial provider={source.provider} mode="reconnect" />
              <TokenRefreshBox
                autoFocus={openFix}
                note="This token is shared by every board using this connection."
                onRefresh={(tok) => REFRESH_BY_PROVIDER[source.provider](source.instanceId, tok)}
              />
            </>
          ) : (
            <p className="text-xs text-slate-600">{ORG_ADMIN_REQUIRED_TO_RECONNECT}</p>
          )}
        </div>
      )}

      {expanded && (
        <div className="p-3 border-t border-slate-100 space-y-3">
          {source.provider === 'jira' && (
            <>
              <JiraBoardZone
                value={draft as JiraZoneValue}
                groups={groups}
                onChange={(v) => setDraft(v)}
                previewCount={null}
                boardId={boardId}
                sourceId={source.id}
                boardStatuses={boardStatuses}
                onSaveStatusMapping={onSaveStatusMapping}
              />
              <FieldMappingEditor
                boardId={boardId}
                sourceId={source.id}
                fieldMappings={source.fieldMappings}
                onChange={handleFieldMappingChange}
              />
            </>
          )}
          {source.provider === 'github' && (
            <>
              <GitHubBoardZone
                value={draft as GitHubZoneValue}
                groups={groups}
                onChange={(v) => setDraft(v)}
                previewCount={null}
                boardId={boardId}
                sourceId={source.id}
                boardStatuses={boardStatuses}
                onSaveStatusMapping={onSaveStatusMapping}
              />
              <CodeIntelZone
                useForIntelligence={draftUseForIntelligence}
                onChange={setDraftUFI}
                connectionState={source.connection}
                lastSyncedAt={source.lastSyncedAt}
                manageHref="/connections"
              />
            </>
          )}
          {source.provider === 'ado' && (
            <>
              <AdoBoardZone
                value={draft as AdoZoneValue}
                groups={groups}
                onChange={(v) => setDraft(v)}
                previewCount={null}
                boardId={boardId}
                sourceId={source.id}
                boardStatuses={boardStatuses}
                onSaveStatusMapping={onSaveStatusMapping}
              />
              <CodeIntelZone
                useForIntelligence={draftUseForIntelligence}
                onChange={setDraftUFI}
                connectionState={draftConnection}
                onConnectionChange={setDraftConnection}
                editableConnection
                lastSyncedAt={source.lastSyncedAt}
                manageHref="/connections"
              />
            </>
          )}
          {source.provider === 'gitlab' && (
            <GitLabBoardZone
              value={draft as GitLabZoneValue}
              groups={groups}
              onChange={(v) => setDraft(v)}
              previewCount={null}
            />
          )}

          {/* Rendered for every provider: exclusions are recorded the same way
              whichever source the deleted row came from. Hides itself when the
              board has nothing excluded for this provider. */}
          <ExcludedItemsBlock boardId={boardId} provider={source.provider} />

          {error && (
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          {outcome && (
            <div
              role="status"
              className={`text-xs rounded-md px-3 py-2 border ${
                outcome.kind === 'error'
                  ? 'text-rose-700 bg-rose-50 border-rose-200'
                  : outcome.kind === 'success'
                    ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                    : 'text-slate-600 bg-slate-50 border-slate-200'
              }`}
            >
              {outcome.text}
            </div>
          )}

          <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-xs font-medium disabled:opacity-60"
              onClick={handleSave}
              disabled={phase !== 'idle'}
            >
              {saveLabel}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 rounded-md border border-slate-200 text-xs text-slate-600"
              disabled={phase !== 'idle'}
              onClick={() => {
                setDraft(source.zoneValue);
                if (source.provider === 'ado') setDraftConnection(source.connection);
                setOutcome(null);
                setError(null);
                setExpanded(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ml-auto text-xs text-rose-600"
              onClick={() => {
                if (confirm('Detach this source?')) onDetach();
              }}
            >
              Detach source
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
