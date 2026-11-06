'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BitbucketBulkAttachRequest,
  BitbucketRemoteProject,
  BitbucketRemoteReposResult,
} from '../../actions/board-sources';
import { SourceReconnectBanner } from './SourceReconnectBanner';

export interface BitbucketInstanceOption {
  id: string;
  label: string;
  isPersonal?: boolean;
}

export interface BitbucketAttachResult {
  ok: boolean;
  message?: string;
  error?: string;
}

interface Props {
  instances: BitbucketInstanceOption[];
  /** Full names (`workspace/repo`) already attached to this board — shown, not selectable. */
  attachedRepos: Set<string>;
  loadRepos: (instanceId: string) => Promise<BitbucketRemoteReposResult>;
  /** Attaches the selection and refreshes the list. Never rejects. */
  onBulkAttach: (req: BitbucketBulkAttachRequest) => Promise<BitbucketAttachResult>;
  onReplaceToken?: (instanceId: string, token: string) => Promise<{ ok: boolean; error?: string }>;
  onDone: () => void;
  onCancel: () => void;
}

const NO_PROJECT = 'Other repositories';

function projectTitle(p: BitbucketRemoteProject): string {
  if (!p.projectKey) return NO_PROJECT;
  return p.projectName && p.projectName !== p.projectKey
    ? `${p.projectName} (${p.projectKey})`
    : p.projectKey;
}

function SelectAll({
  label,
  checked,
  indeterminate,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/**
 * Bitbucket's pick step in the "+ Add source" wizard.
 *
 * Repositories are listed live from the connection and grouped by Bitbucket
 * project, because that is how teams own them — a frontend team ticks "Select
 * all in FE" instead of a dozen boxes. The selection is attached in one bulk
 * call; already-attached repositories stay visible (so the list matches what
 * the user sees in Bitbucket) but cannot be picked twice.
 */
export function BitbucketSourcePicker({
  instances,
  attachedRepos,
  loadRepos,
  onBulkAttach,
  onReplaceToken,
  onDone,
  onCancel,
}: Props) {
  const [instanceId, setInstanceId] = useState(instances[0]?.id ?? '');
  const [projects, setProjects] = useState<BitbucketRemoteProject[] | null>(null);
  const [workspace, setWorkspace] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authFailed, setAuthFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Map<string, string | null>>(new Map());
  const [pending, setPending] = useState(false);
  // Switching connections quickly must not paint connection A's repos under B:
  // only the newest request may write state.
  const requestSeq = useRef(0);

  const load = useCallback(
    async (id: string) => {
      if (!id) return;
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      setAuthFailed(false);
      setProjects(null);
      setSelected(new Map());
      const result = await loadRepos(id);
      if (seq !== requestSeq.current) return;
      setLoading(false);
      if (result.ok) {
        setProjects(result.projects);
        setWorkspace(result.workspace);
      } else {
        setAuthFailed(result.authFailed);
        setError(result.error);
      }
    },
    [loadRepos],
  );

  useEffect(() => {
    void load(instanceId);
  }, [instanceId, load]);

  const term = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      (projects ?? [])
        .map((p) => ({
          ...p,
          repos: term
            ? p.repos.filter(
                (r) => r.fullName.toLowerCase().includes(term) || (p.projectKey ?? '').toLowerCase() === term,
              )
            : p.repos,
        }))
        .filter((p) => p.repos.length > 0),
    [projects, term],
  );

  const toggleRepo = (fullName: string, projectKey: string | null) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(fullName)) next.delete(fullName);
      else next.set(fullName, projectKey);
      return next;
    });

  const setProject = (p: BitbucketRemoteProject, on: boolean) =>
    setSelected((prev) => {
      const next = new Map(prev);
      for (const r of p.repos) {
        if (attachedRepos.has(r.fullName)) continue;
        if (on) next.set(r.fullName, r.projectKey);
        else next.delete(r.fullName);
      }
      return next;
    });

  const submit = async () => {
    if (pending || selected.size === 0) return;
    setPending(true);
    setError(null);
    const result = await onBulkAttach({
      instanceId,
      repos: [...selected].map(([fullName, projectKey]) =>
        projectKey ? { fullName, projectKey } : { fullName },
      ),
    });
    setPending(false);
    if (result.ok) {
      onDone();
      return;
    }
    setError(result.error ?? 'Could not attach these repositories.');
  };

  return (
    <div className="space-y-3">
      {instances.length > 1 && (
        <div>
          <label className="block text-[11px] text-slate-500" htmlFor="bb-instance">
            Bitbucket connection
          </label>
          <select
            id="bb-instance"
            aria-label="Bitbucket connection"
            className="w-full text-xs px-2 py-1.5 rounded-md border border-slate-200"
            value={instanceId}
            onChange={(e) => setInstanceId(e.target.value)}
          >
            {instances.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
                {i.isPersonal ? ' (yours)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {authFailed && onReplaceToken && (
        <SourceReconnectBanner
          provider="bitbucket"
          message={error ?? undefined}
          onReplaceToken={(token) => onReplaceToken(instanceId, token)}
          onSuccess={() => void load(instanceId)}
        />
      )}

      {error && !authFailed && (
        <p className="text-xs text-rose-600" role="alert">
          {error}
        </p>
      )}

      {loading && <p className="text-xs text-slate-500">Loading repositories from Bitbucket…</p>}

      {projects && (
        <>
          <div className="flex items-center gap-2">
            <input
              className="flex-1 text-xs px-3 py-1.5 rounded-md border border-slate-200"
              aria-label="Search Bitbucket repositories"
              placeholder={`Search repositories in ${workspace || 'this workspace'}…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="text-[11px] text-slate-500 whitespace-nowrap" aria-live="polite">
              {selected.size} selected
            </span>
          </div>

          {visible.length === 0 ? (
            <p className="text-xs text-slate-500">
              {projects.length === 0
                ? 'This connection cannot see any repositories. Check the token’s read:repository:bitbucket scope.'
                : 'No repositories match that search.'}
            </p>
          ) : (
            <div className="max-h-80 overflow-auto space-y-3">
              {visible.map((p) => {
                const pickable = p.repos.filter((r) => !attachedRepos.has(r.fullName));
                const picked = pickable.filter((r) => selected.has(r.fullName)).length;
                const key = p.projectKey ?? NO_PROJECT;
                return (
                  <fieldset key={key} className="rounded-md border border-slate-200">
                    <legend className="sr-only">{projectTitle(p)}</legend>
                    <label className="flex items-center gap-2 px-3 py-2 bg-slate-50 border-b border-slate-100 text-xs font-semibold text-slate-800">
                      <SelectAll
                        label={`Select all in ${p.projectKey ?? NO_PROJECT}`}
                        checked={pickable.length > 0 && picked === pickable.length}
                        indeterminate={picked > 0 && picked < pickable.length}
                        disabled={pickable.length === 0}
                        onChange={(on) => setProject({ ...p, repos: pickable }, on)}
                      />
                      {projectTitle(p)}
                      <span className="ml-auto text-[10px] font-normal text-slate-400">
                        {p.repos.length} {p.repos.length === 1 ? 'repository' : 'repositories'}
                      </span>
                    </label>
                    <div className="py-1">
                      {p.repos.map((r) => {
                        const attached = attachedRepos.has(r.fullName);
                        return (
                          <label
                            key={r.fullName}
                            className={`flex items-center gap-2 px-3 py-1.5 text-xs ${
                              attached ? 'text-slate-400' : 'cursor-pointer hover:bg-slate-50'
                            }`}
                          >
                            <input
                              type="checkbox"
                              aria-label={r.fullName}
                              checked={attached || selected.has(r.fullName)}
                              disabled={attached}
                              onChange={() => toggleRepo(r.fullName, r.projectKey)}
                            />
                            <span className="font-mono">{r.slug}</span>
                            {r.isPrivate && <span className="text-[10px] text-slate-400">private</span>}
                            {attached && <span className="text-[10px]">already attached</span>}
                            {r.mainBranch && (
                              <span className="ml-auto text-[10px] text-slate-400">{r.mainBranch}</span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                );
              })}
            </div>
          )}
          <p className="text-[11px] text-slate-500">
            Pull requests, commits and deployments sync for engineering intelligence. Tasks keep
            coming from Jira — no rows are added to the board.
          </p>
        </>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-xs disabled:opacity-50"
          disabled={selected.size === 0 || pending}
          onClick={submit}
        >
          {pending
            ? 'Attaching…'
            : `Attach ${selected.size} ${selected.size === 1 ? 'repository' : 'repositories'}`}
        </button>
        <button
          type="button"
          className="px-3 py-1.5 rounded-md border border-slate-200 text-xs text-slate-600"
          onClick={onCancel}
        >
          Back
        </button>
      </div>
    </div>
  );
}
