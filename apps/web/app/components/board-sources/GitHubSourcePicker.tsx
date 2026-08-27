'use client';

import { useState } from 'react';
import type { BulkBindRequest, PickerResponse, GitHubPickerError } from '@deckgauge/shared';
import { GitHubRepoPicker } from '../../boards/[boardId]/sources/components/GitHubRepoPicker';
import { SourceReconnectBanner } from './SourceReconnectBanner';

export interface GitHubInstanceOption {
  id: string;
  label: string;
  /**
   * Personal to the caller. Optional so existing callers keep compiling; absent
   * means organization-wide, which is the safe reading — the API never offers a
   * connection the caller may not use, so an unmarked option is always usable.
   */
  isPersonal?: boolean;
}

export interface BulkAttachResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export interface ReplaceTokenResult {
  ok: boolean;
  error?: string;
}

interface Props {
  boardId: string;
  instances: GitHubInstanceOption[];
  /** Runs the bulk bind + client refresh. Never rejects. */
  onBulkAttach: (req: BulkBindRequest) => Promise<BulkAttachResult>;
  /** Called after a successful bulk attach so the wizard can close. */
  onDone: () => void;
  /** Called when the user backs out of the picker. */
  onCancel: () => void;
  /**
   * Replaces the connection's access token (used to recover from an expired
   * PAT). Never rejects. When omitted, the token-replace form is not shown.
   */
  onReplaceToken?: (instanceId: string, token: string) => Promise<ReplaceTokenResult>;
  /** Test seam forwarded to GitHubRepoPicker; production uses the default fetcher. */
  fetcher?: (p: {
    pattern: string;
    page: number;
    includeArchived: boolean;
  }) => Promise<PickerResponse | GitHubPickerError>;
}

/**
 * GitHub's pick step in the "+ Add source" wizard. Discovers repos live from the
 * connection and provisions them through the bulk-bind path (tiering + backfill).
 * When the connection's token is expired (github_auth_failed), it surfaces the
 * error and offers an inline token-replace form so the user can recover without
 * leaving the wizard.
 */
export function GitHubSourcePicker({
  boardId,
  instances,
  onBulkAttach,
  onDone,
  onCancel,
  onReplaceToken,
  fetcher,
}: Props) {
  const [instanceId, setInstanceId] = useState(instances[0]?.id ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authFailed, setAuthFailed] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const selectInstance = (id: string) => {
    setInstanceId(id);
    setAuthFailed(false);
  };

  const submit = async (req: Omit<BulkBindRequest, 'instanceId'>) => {
    if (pending || !instanceId) return;
    setPending(true);
    setError(null);
    const result = await onBulkAttach({ instanceId, ...req });
    setPending(false);
    if (result.ok) {
      onDone();
      return;
    }
    setError(result.error ?? 'Bulk add failed.');
  };

  const handlePickerError = (err: GitHubPickerError) => {
    setAuthFailed(err.code === 'github_auth_failed');
  };

  return (
    <div className="space-y-2">
      {instances.length > 1 && (
        <div>
          <label className="block text-[11px] text-slate-500" htmlFor="gh-instance">
            GitHub connection
          </label>
          <select
            id="gh-instance"
            aria-label="GitHub connection"
            className="w-full text-xs px-2 py-1.5 rounded-md border border-slate-200"
            value={instanceId}
            onChange={(e) => selectInstance(e.target.value)}
          >
            {/* Grouped so the user can see WHOSE credential the board will spend:
                attaching a personal connection starts a recurring sync against its
                owner's token. The API has already filtered out anything the caller
                may not use, so this is about clarity rather than access. An empty
                group renders no heading — "Your connections" over nothing reads as
                though something failed to load. */}
            {[
              { label: 'Organization connections', rows: instances.filter((i) => !i.isPersonal) },
              { label: 'Your connections', rows: instances.filter((i) => i.isPersonal) },
            ]
              .filter((group) => group.rows.length > 0)
              .map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.rows.map((inst) => (
                    <option key={inst.id} value={inst.id}>
                      {inst.label}
                    </option>
                  ))}
                </optgroup>
              ))}
          </select>
        </div>
      )}
      {error && (
        <p className="text-xs text-rose-600" role="alert">
          {error}
        </p>
      )}

      {authFailed && onReplaceToken && (
        <SourceReconnectBanner
          provider="github"
          onReplaceToken={(token) => onReplaceToken(instanceId, token)}
          onSuccess={() => {
            setAuthFailed(false);
            setReloadNonce((n) => n + 1); // remount the picker → refetch with the new token
          }}
        />
      )}

      <GitHubRepoPicker
        key={`${instanceId}:${reloadNonce}`}
        boardId={boardId}
        instanceId={instanceId}
        onCancel={onCancel}
        onSubmit={submit}
        onError={handlePickerError}
        fetcher={fetcher}
      />
    </div>
  );
}
