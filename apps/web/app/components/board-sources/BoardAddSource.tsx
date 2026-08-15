'use client';
import { useState } from 'react';
import type { BulkBindRequest, ConnectionHint } from '@deckgauge/shared';
import {
  PROVIDER_LABEL,
  PROVIDER_ROLE_FIELDS,
  defaultRoleFlags,
  type Provider,
} from './providers/roles';
import { AddConnectionForm } from './AddConnectionForm';
import {
  GitHubSourcePicker,
  type GitHubInstanceOption,
  type BulkAttachResult,
} from './GitHubSourcePicker';
import { SourceReconnectBanner } from './SourceReconnectBanner';
import { SourceHostFixBanner } from './SourceHostFixBanner';
import type { RemoteProjectsResult } from '../../actions/board-sources';

export type { Provider } from './providers/roles';

export interface ReadyProviderEntry {
  id: string;
  label: string;
  codeState?: 'PRs+commits' | 'PRs only' | 'commits only' | 'no code sync';
}

export type ReadyProviders = Record<Provider, ReadyProviderEntry[]>;

export interface CartItem {
  provider: Provider;
  syncId: string;
  label: string;
  roles: Record<string, boolean>;
}

export interface AttachResult {
  item: CartItem;
  ok: boolean;
  error?: string;
}

export interface AddNewActions {
  listConnections: (provider: Provider) => Promise<Array<{ id: string; name: string }>>;
  listRemoteProjects: (
    provider: Provider,
    connectionId: string,
    search?: string,
  ) => Promise<RemoteProjectsResult>;
  ensureSync: (
    provider: Provider,
    connectionId: string,
    projectKey: string,
  ) => Promise<{ syncId: string; label: string }>;
  createConnection: (
    provider: Provider,
    values: Record<string, string>,
  ) => Promise<{ id: string; name: string }>;
  testConnection: (
    provider: Provider,
    connectionId: string,
  ) => Promise<{ ok: boolean; error?: string; hint?: ConnectionHint }>;
  /** Repoints an existing connection at a different base URL. Never rejects. */
  updateConnectionUrl: (
    provider: Provider,
    connectionId: string,
    url: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}

interface Props {
  /** Required only for the GitHub live picker (bulk-bind) path. */
  boardId?: string;
  readyProviders: ReadyProviders;
  /**
   * Sources already attached to this board, keyed `${provider}:${name}`. Used to
   * hide already-attached projects from the picker so they can't be re-added
   * (which the API rejects with 409). Optional; defaults to none.
   */
  attachedKeys?: Set<string>;
  onCancel: () => void;
  /** Attaches every cart item; resolves with a per-item result. Never rejects. */
  onAttachMany: (items: CartItem[]) => Promise<AttachResult[]>;
  addNewActions?: AddNewActions;
  /**
   * GitHub connections available to this board. When present (≥1), the GitHub
   * provider uses the live repo picker + backfill (bulk-bind) instead of the
   * ready-list flow. Defaults to none, which keeps the ready-list/add-new flow.
   */
  githubInstances?: GitHubInstanceOption[];
  /** Bulk-binds selected GitHub repos and refreshes the list. Never rejects. */
  onBulkAttachGitHub?: (req: BulkBindRequest) => Promise<BulkAttachResult>;
  /** Replaces an expired connection token (validate-before-swap). Never rejects. */
  onReplaceToken?: (
    provider: Provider,
    connectionId: string,
    token: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** When set, the wizard opens directly on the pick step for this provider. */
  initialProvider?: Provider;
}

type Step = 'provider' | 'pick' | 'review';

const PROVIDERS: Provider[] = ['jira', 'github', 'ado', 'gitlab'];

export function BoardAddSource({
  boardId,
  readyProviders,
  attachedKeys,
  onCancel,
  onAttachMany,
  addNewActions,
  githubInstances,
  onBulkAttachGitHub,
  onReplaceToken,
  initialProvider,
}: Props) {
  const [step, setStep] = useState<Step>(initialProvider ? 'pick' : 'provider');
  const [provider, setProvider] = useState<Provider | null>(initialProvider ?? null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [committing, setCommitting] = useState(false);
  const [results, setResults] = useState<AttachResult[] | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [newConn, setNewConn] = useState(false);
  const [connections, setConnections] = useState<Array<{ id: string; name: string }>>([]);
  const [connectionId, setConnectionId] = useState<string>('');
  const [remoteProjects, setRemoteProjects] = useState<string[] | null>(null);
  const [remoteSearch, setRemoteSearch] = useState('');
  const [subBusy, setSubBusy] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState(false);
  // Held with its connection id: the wizard has created the connection but not
  // yet adopted it (`connectionId` stays empty until a test passes).
  const [hostHint, setHostHint] = useState<{ hint: ConnectionHint; connectionId: string } | null>(
    null,
  );

  const goToProviderStep = () => {
    setStep('provider');
    setProvider(null);
    setSelected(new Set());
    setSearch('');
    setResults(null);
    setAddingNew(false);
    setNewConn(false);
    setConnections([]);
    setConnectionId('');
    setRemoteProjects(null);
    setRemoteSearch('');
    setSubError(null);
    setHostHint(null);
    setReconnect(false);
  };

  const advanceToPick = () => {
    if (!provider) return;
    setSelected(new Set());
    setSearch('');
    setStep('pick');
    setAddingNew(false);
    setNewConn(false);
    setConnections([]);
    setConnectionId('');
    setRemoteProjects(null);
    setRemoteSearch('');
    setSubError(null);
    setHostHint(null);
    setReconnect(false);
  };

  // GitHub uses the live repo picker (bulk-bind + backfill) instead of the
  // ready-list flow, but only when a connection exists and a bulk handler is
  // wired. With no connection we fall back to the ready-list/add-new flow so
  // the first GitHub connection can still be bootstrapped.
  const githubPickerMode =
    step === 'pick' &&
    provider === 'github' &&
    (githubInstances?.length ?? 0) > 0 &&
    !!onBulkAttachGitHub;

  const isAttached = (p: Provider, name: string) =>
    attachedKeys?.has(`${p}:${name}`) ?? false;

  const errorFor = (c: CartItem): string | null =>
    results?.find((r) => !r.ok && r.item.provider === c.provider && r.item.syncId === c.syncId)
      ?.error ?? null;

  const filtered = provider
    ? readyProviders[provider].filter(
        (e) =>
          e.label.toLowerCase().includes(search.toLowerCase()) &&
          !isAttached(provider, e.label),
      )
    : [];

  const inCart = (p: Provider, id: string) =>
    cart.some((c) => c.provider === p && c.syncId === id);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addSelectedToCart = () => {
    if (!provider || selected.size === 0) return;
    const entries = readyProviders[provider].filter(
      (e) => selected.has(e.id) && !inCart(provider, e.id),
    );
    const additions: CartItem[] = entries.map((e) => ({
      provider,
      syncId: e.id,
      label: e.label,
      roles: defaultRoleFlags(provider),
    }));
    setCart((prev) => [...prev, ...additions]);
    setSelected(new Set());
    setStep('review');
  };

  const removeFromCart = (p: Provider, syncId: string) =>
    setCart((prev) => prev.filter((c) => !(c.provider === p && c.syncId === syncId)));

  const setRole = (p: Provider, syncId: string, key: string, value: boolean) =>
    setCart((prev) =>
      prev.map((c) =>
        c.provider === p && c.syncId === syncId
          ? { ...c, roles: { ...c.roles, [key]: value } }
          : c,
      ),
    );

  const commit = async () => {
    if (cart.length === 0) return;
    setCommitting(true);
    setResults(null);
    const res = await onAttachMany(cart);
    setCommitting(false);
    const failed = res.filter((r) => !r.ok);
    if (failed.length === 0) {
      onCancel();
      return;
    }
    setResults(res);
    setCart(failed.map((r) => r.item));
  };

  const openAddNew = async () => {
    if (!provider || !addNewActions) return;
    setAddingNew(true);
    setSubError(null);
    setHostHint(null);
    setRemoteProjects(null);
    setSubBusy(true);
    try {
      const conns = await addNewActions.listConnections(provider);
      setConnections(conns);
      setConnectionId(conns.length === 1 ? conns[0].id : '');
    } catch {
      setSubError('Could not load connections.');
    } finally {
      setSubBusy(false);
    }
  };

  const loadRemoteProjects = async () => {
    if (!provider || !addNewActions || !connectionId) return;
    setSubBusy(true);
    setSubError(null);
    setReconnect(false);
    try {
      const result = await addNewActions.listRemoteProjects(provider, connectionId, remoteSearch);
      if (result.ok) {
        setRemoteProjects(result.projects);
      } else if (result.authFailed) {
        setReconnect(true);
        setRemoteProjects(null);
      } else {
        setSubError(result.error || 'Could not load projects for this connection.');
        setRemoteProjects([]);
      }
    } catch {
      setSubError('Could not load projects for this connection.');
      setRemoteProjects([]);
    } finally {
      setSubBusy(false);
    }
  };

  const chooseRemoteProject = async (projectKey: string) => {
    if (!provider || !addNewActions || !connectionId) return;
    if (isAttached(provider, projectKey)) {
      setSubError('That project is already attached to this board.');
      return;
    }
    setSubBusy(true);
    setSubError(null);
    try {
      const { syncId, label } = await addNewActions.ensureSync(provider, connectionId, projectKey);
      if (!inCart(provider, syncId)) {
        setCart((prev) => [
          ...prev,
          { provider, syncId, label, roles: defaultRoleFlags(provider) },
        ]);
      }
      setAddingNew(false);
      setRemoteProjects(null);
      setRemoteSearch('');
      setStep('review');
    } catch {
      setSubError('Could not add that project. It may already be attached.');
    } finally {
      setSubBusy(false);
    }
  };

  /** Adopt a validated connection and load its remote projects. */
  const adoptConnection = async (conn: { id: string; name: string }) => {
    if (!provider || !addNewActions) return;
    setConnections((prev) => (prev.some((c) => c.id === conn.id) ? prev : [...prev, conn]));
    setConnectionId(conn.id);
    setNewConn(false);
    const result = await addNewActions.listRemoteProjects(provider, conn.id, remoteSearch);
    if (result.ok) {
      setRemoteProjects(result.projects);
      return;
    }
    if (result.authFailed) {
      setReconnect(true);
      return;
    }
    setSubError(result.error || 'Could not load projects for this connection.');
    setRemoteProjects([]);
  };

  const createAndTest = async (values: Record<string, string>) => {
    if (!provider || !addNewActions) return;
    setSubBusy(true);
    setSubError(null);
    setHostHint(null);
    try {
      const conn = await addNewActions.createConnection(provider, values);
      const test = await addNewActions.testConnection(provider, conn.id);
      if (!test.ok) {
        setSubError(test.error ?? 'Connection test failed.');
        if (test.hint) setHostHint({ hint: test.hint, connectionId: conn.id });
        return;
      }
      await adoptConnection(conn);
    } catch {
      setSubError('Could not create the connection.');
    } finally {
      setSubBusy(false);
    }
  };

  /** Repoint the just-created connection at the canonical host and retry. */
  const applyHostHint = async () => {
    if (!provider || !addNewActions || !hostHint) return;
    const { hint, connectionId: id } = hostHint;
    setSubBusy(true);
    setSubError(null);
    try {
      const patched = await addNewActions.updateConnectionUrl(provider, id, hint.suggestedUrl);
      if (!patched.ok) {
        setSubError(patched.error ?? 'Could not update the connection URL.');
        setHostHint(null);
        return;
      }
      const test = await addNewActions.testConnection(provider, id);
      if (!test.ok) {
        setSubError(test.error ?? 'Connection test failed.');
        setHostHint(null);
        return;
      }
      setHostHint(null);
      await adoptConnection({ id, name: hint.suggestedUrl });
    } catch {
      setSubError('Could not update the connection URL.');
      setHostHint(null);
    } finally {
      setSubBusy(false);
    }
  };

  /** Dismiss the new-connection form, discarding any leftover fix offer or error. */
  const cancelNewConnection = () => {
    setNewConn(false);
    setHostHint(null);
    setSubError(null);
  };

  // GitLab searches server-side (it can match on project name/description, not
  // just the path), so re-applying a client-side path substring filter would
  // wrongly hide valid matches — skip it for GitLab and trust the server list.
  // Other providers load the full list once and filter it here.
  const filteredRemote = (remoteProjects ?? []).filter(
    (p) =>
      (provider === 'gitlab' || p.toLowerCase().includes(remoteSearch.toLowerCase())) &&
      !(provider && isAttached(provider, p)),
  );

  return (
    <div className="rounded-lg border border-indigo-500 bg-white shadow-md mb-3 overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-100 flex items-center gap-3 text-sm font-semibold text-slate-900">
        <span className="w-5 h-5 rounded bg-indigo-50 text-indigo-600 flex items-center justify-center text-xs">
          +
        </span>
        {step === 'provider'
          ? 'Add source'
          : step === 'pick'
            ? `Pick ${provider ? PROVIDER_LABEL[provider] : ''} projects`
            : 'Review & attach'}
        {cart.length > 0 && (
          <span className="ml-auto text-[10px] uppercase tracking-wider text-indigo-500">
            {cart.length} in cart
          </span>
        )}
      </div>

      <div className="p-4">
        {step === 'provider' && (
          <div>
            <p className="text-xs text-slate-500 mb-3">Where is this source coming from?</p>
            <div className="grid grid-cols-2 gap-2">
              {PROVIDERS.map((p) => {
                const count = readyProviders[p].length;
                const on = provider === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setProvider(p)}
                    aria-label={PROVIDER_LABEL[p]}
                    className={`p-3 rounded-lg border text-left flex items-center gap-2 text-sm ${
                      on ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-indigo-300'
                    }`}
                  >
                    {PROVIDER_LABEL[p]}
                    <span className="ml-auto text-[10px] text-slate-400">{count} ready</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {githubPickerMode && (
          <GitHubSourcePicker
            boardId={boardId ?? ''}
            instances={githubInstances ?? []}
            onBulkAttach={onBulkAttachGitHub!}
            onReplaceToken={
              onReplaceToken
                ? (instanceId, token) => onReplaceToken('github', instanceId, token)
                : undefined
            }
            onDone={onCancel}
            onCancel={goToProviderStep}
          />
        )}

        {step === 'pick' && provider && !githubPickerMode && (
          <div>
            {reconnect && onReplaceToken && connectionId && (
              <SourceReconnectBanner
                provider={provider}
                onReplaceToken={(token) => onReplaceToken(provider, connectionId, token)}
                onSuccess={() => {
                  setReconnect(false);
                  void loadRemoteProjects();
                }}
              />
            )}
            {!reconnect && (
            <>
            {readyProviders[provider].length === 0 ? (
              addNewActions ? (
                !addingNew ? (
                  <div className="text-xs text-slate-500">
                    <p>
                      No {PROVIDER_LABEL[provider]} projects connected yet. Connect{' '}
                      {PROVIDER_LABEL[provider]} to pick projects to sync to this board.
                    </p>
                    <button
                      type="button"
                      onClick={openAddNew}
                      className="mt-2 inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                    >
                      Connect {PROVIDER_LABEL[provider]}
                    </button>
                  </div>
                ) : null
              ) : (
                <p className="text-xs text-slate-500">
                  No existing {PROVIDER_LABEL[provider]} projects yet.{' '}
                  <a href="/sources" className="text-indigo-600 hover:underline">
                    Set one up in Sources &rarr;
                  </a>
                </p>
              )
            ) : (
              <>
                <input
                  className="w-full text-xs px-3 py-1.5 rounded-md border border-slate-200 mb-2"
                  aria-label={`Search ${PROVIDER_LABEL[provider]} projects`}
                  placeholder="Search…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="space-y-1">
                  {filtered.map((entry) => {
                    const already = inCart(provider, entry.id);
                    const checked = selected.has(entry.id) || already;
                    return (
                      <label
                        key={entry.id}
                        className={`w-full text-left px-3 py-2 rounded-md text-xs flex items-center gap-2 cursor-pointer ${
                          checked ? 'bg-indigo-50' : 'hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={already}
                          onChange={() => toggle(entry.id)}
                          aria-label={entry.label}
                        />
                        <span className="font-mono">{entry.label}</span>
                        {already && <span className="text-[10px] text-slate-400">in cart</span>}
                        {entry.codeState && (
                          <span className="ml-auto text-[10px] text-slate-400">{entry.codeState}</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </>
            )}

            {addNewActions && !addingNew && readyProviders[provider].length > 0 && (
              <button
                type="button"
                className="mt-3 text-xs text-indigo-600 hover:underline"
                onClick={openAddNew}
              >
                + Add a project not in this list
              </button>
            )}

            {addNewActions && addingNew && (
              <div className="mt-3 rounded-md border border-slate-200 p-3 space-y-2">
                {hostHint && (
                  <SourceHostFixBanner
                    suggestedUrl={hostHint.hint.suggestedUrl}
                    busy={subBusy}
                    onUseSuggested={applyHostHint}
                  />
                )}
                {subError && <p className="text-xs text-rose-600">{subError}</p>}
                {newConn ? (
                  <AddConnectionForm
                    provider={provider}
                    busy={subBusy}
                    onSubmit={createAndTest}
                    onCancel={cancelNewConnection}
                  />
                ) : connections.length === 0 && !subBusy ? (
                  <>
                    <p className="text-xs text-slate-500">No {PROVIDER_LABEL[provider]} connections yet.</p>
                    <button
                      type="button"
                      className="text-xs text-indigo-600 hover:underline"
                      onClick={() => setNewConn(true)}
                    >
                      + New connection
                    </button>
                  </>
                ) : (
                  <>
                    <label className="block text-[11px] text-slate-500">Connection</label>
                    <select
                      className="w-full text-xs px-2 py-1.5 rounded-md border border-slate-200"
                      aria-label="Connection"
                      value={connectionId}
                      onChange={(e) => {
                        setConnectionId(e.target.value);
                        setRemoteProjects(null);
                      }}
                    >
                      <option value="">Select a connection…</option>
                      {connections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <div className="flex gap-2">
                      <input
                        className="flex-1 text-xs px-2 py-1.5 rounded-md border border-slate-200"
                        aria-label="Search remote projects"
                        placeholder="Search projects…"
                        value={remoteSearch}
                        disabled={!connectionId || subBusy}
                        onChange={(e) => setRemoteSearch(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void loadRemoteProjects();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="text-xs px-2 py-1 rounded-md bg-indigo-600 text-white disabled:opacity-50 whitespace-nowrap"
                        disabled={!connectionId || subBusy}
                        onClick={loadRemoteProjects}
                      >
                        {subBusy ? 'Loading…' : remoteSearch.trim() ? 'Search' : 'Load projects'}
                      </button>
                    </div>

                    {remoteProjects !== null &&
                      (remoteProjects.length === 0 ? (
                        <p className="text-xs text-slate-500">
                          No projects found
                          {remoteSearch.trim() ? ` for “${remoteSearch.trim()}”` : ''}. Type a
                          name and Search to find any project you can access.
                        </p>
                      ) : filteredRemote.length === 0 ? (
                        <p className="text-xs text-slate-500">
                          Every matching project is already attached to this board.
                        </p>
                      ) : (
                        <div className="max-h-40 overflow-auto space-y-1">
                          {filteredRemote.map((p) => (
                            <button
                              key={p}
                              type="button"
                              className="w-full text-left px-2 py-1.5 rounded-md text-xs font-mono hover:bg-indigo-50 disabled:opacity-50"
                              disabled={subBusy}
                              onClick={() => chooseRemoteProject(p)}
                            >
                              {p}
                            </button>
                          ))}
                        </div>
                      ))}
                    {!subBusy && (
                      <button
                        type="button"
                        className="text-[11px] text-indigo-600 hover:underline"
                        onClick={() => setNewConn(true)}
                      >
                        + New connection
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            </>
            )}
          </div>
        )}

        {step === 'review' && (
          <div className="space-y-2">
            {results && results.some((r) => !r.ok) && (
              <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-700">
                {results.filter((r) => !r.ok).length} source(s) failed to attach. They remain below; fix and retry.
              </div>
            )}
            {cart.length === 0 ? (
              <p className="text-xs text-slate-500">Cart is empty. Add a source to continue.</p>
            ) : (
              cart.map((c) => (
                <div
                  key={`${c.provider}:${c.syncId}`}
                  className="rounded-md border border-slate-200 px-3 py-2 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-slate-400">
                      {PROVIDER_LABEL[c.provider]}
                    </span>
                    <span className="font-mono text-slate-700">{c.label}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${c.label}`}
                      className="ml-auto text-rose-600 hover:underline"
                      onClick={() => removeFromCart(c.provider, c.syncId)}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-3">
                    {PROVIDER_ROLE_FIELDS[c.provider].length === 0 ? (
                      <span className="text-slate-500">Feeds issues to board</span>
                    ) : (
                      PROVIDER_ROLE_FIELDS[c.provider].map((f) => (
                        <label key={f.key} className="flex items-center gap-1 text-slate-700">
                          <input
                            type="checkbox"
                            checked={c.roles[f.key] ?? false}
                            onChange={(e) => setRole(c.provider, c.syncId, f.key, e.target.checked)}
                          />
                          {f.label}
                        </label>
                      ))
                    )}
                  </div>
                  {errorFor(c) && (
                    <p className="mt-1 text-[11px] text-rose-600" role="alert">
                      {errorFor(c)}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="px-4 py-2 bg-slate-50 border-t border-slate-100 flex gap-2">
        {step === 'provider' && (
          <>
            <button
              type="button"
              className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-xs disabled:opacity-50"
              disabled={!provider}
              onClick={advanceToPick}
            >
              Continue
            </button>
            {cart.length > 0 && (
              <button
                type="button"
                className="px-3 py-1.5 rounded-md border border-slate-200 text-xs text-slate-600"
                onClick={() => setStep('review')}
              >
                Review cart ({cart.length})
              </button>
            )}
            <button
              type="button"
              className="px-3 py-1.5 rounded-md border border-slate-200 text-xs text-slate-600"
              onClick={onCancel}
            >
              Cancel
            </button>
          </>
        )}
        {step === 'pick' && !githubPickerMode && (
          <>
            <button
              type="button"
              className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-xs disabled:opacity-50"
              disabled={selected.size === 0}
              onClick={addSelectedToCart}
            >
              Add selected
            </button>
            <button
              type="button"
              className="px-3 py-1.5 rounded-md border border-slate-200 text-xs text-slate-600"
              onClick={goToProviderStep}
            >
              Back
            </button>
          </>
        )}
        {step === 'review' && (
          <>
            <button
              type="button"
              className="px-3 py-1.5 rounded-md bg-indigo-600 text-white text-xs disabled:opacity-50"
              disabled={cart.length === 0 || committing}
              onClick={commit}
            >
              {committing ? 'Attaching…' : `Attach ${cart.length} source${cart.length === 1 ? '' : 's'}`}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 rounded-md border border-slate-200 text-xs text-slate-600"
              onClick={goToProviderStep}
            >
              + Add more
            </button>
            <button
              type="button"
              className="px-3 py-1.5 rounded-md border border-slate-200 text-xs text-slate-600"
              onClick={onCancel}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
