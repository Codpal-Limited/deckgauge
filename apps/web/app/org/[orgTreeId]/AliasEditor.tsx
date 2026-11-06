'use client';

import { useState } from 'react';
import { addEmployeeAlias, deleteEmployeeAlias } from '@/app/actions/org-trees';
import type { OrgEmployeeAliasDto } from '@deckgauge/shared';
import type { OrgEmployeeAliasInput } from '@/app/actions/org-trees';

interface AliasEditorProps {
  employeeId: string;
  initialAliases: OrgEmployeeAliasDto[];
}

const PROVIDERS: OrgEmployeeAliasInput['provider'][] = ['github', 'gitlab', 'bitbucket', 'ado', 'jira'];
const KINDS: OrgEmployeeAliasInput['kind'][] = ['login', 'email', 'name'];

export function AliasEditor({ employeeId, initialAliases }: AliasEditorProps) {
  const [aliases, setAliases] = useState<OrgEmployeeAliasDto[]>(initialAliases);
  const [provider, setProvider] = useState<OrgEmployeeAliasInput['provider']>('github');
  const [kind, setKind] = useState<OrgEmployeeAliasInput['kind']>('login');
  const [value, setValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const alias = await addEmployeeAlias(employeeId, { provider, kind, value: value.trim() });
      setAliases((prev) => [...prev, alias]);
      setValue('');
    } catch {
      setError('Failed to add alias');
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(aliasId: string) {
    const result = await deleteEmployeeAlias(aliasId);
    if (result.ok) {
      setAliases((prev) => prev.filter((a) => a.id !== aliasId));
    }
  }

  return (
    <div className="mt-3 rounded border border-gray-200 bg-white p-3">
      <h4 className="mb-2 text-sm font-semibold text-gray-700">Aliases</h4>

      <ul className="mb-3 space-y-1">
        {aliases.map((alias) => (
          <li key={alias.id} className="flex items-center gap-2 text-sm">
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
              {alias.provider}
            </span>
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
              {alias.kind}
            </span>
            <span className="flex-1 text-gray-700">{alias.value}</span>
            <button
              onClick={() => handleDelete(alias.id)}
              className="text-xs text-red-500 hover:text-red-700"
              aria-label={`Remove alias ${alias.value}`}
            >
              ✕
            </button>
          </li>
        ))}
        {aliases.length === 0 && <li className="text-xs text-gray-400">No aliases yet.</li>}
      </ul>

      <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-2">
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as OrgEmployeeAliasInput['provider'])}
          className="rounded border border-gray-300 px-2 py-1 text-sm"
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as OrgEmployeeAliasInput['kind'])}
          className="rounded border border-gray-300 px-2 py-1 text-sm"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>

        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="alias value"
          className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
        />

        <button
          type="submit"
          disabled={adding || !value.trim()}
          className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {adding ? 'Adding…' : 'Add'}
        </button>
      </form>

      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}
