'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  PROVIDER_CONNECTION_FIELDS,
  requiredKeys,
} from '../board-sources/providers/connection-fields';
import { PROVIDER_LABEL, type Provider } from '../board-sources/providers/roles';
import { TokenTutorial } from '../board-sources/providers/TokenTutorial';
import { createConnection } from '../../actions/connections';

const PROVIDERS: Provider[] = ['jira', 'github', 'ado', 'gitlab'];

function initialValues(provider: Provider): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const f of PROVIDER_CONNECTION_FIELDS[provider]) {
    if (f.type === 'select' && f.options?.[0]) seed[f.key] = f.options[0].value;
  }
  return seed;
}

/**
 * Creating a connection lives here, on the organization-admin Connections
 * screen, and nowhere else.
 *
 * It used to live inline in the board Sources tab, where five of the six staging
 * accounts would have hit a 403 on submit: `POST /*\/instances` requires the
 * organization ADMIN role. The page around this panel is gated on that role, so
 * everyone who can see this form can use it.
 */
export function AddConnectionPanel() {
  const router = useRouter();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const choose = (p: Provider) => {
    setProvider(p);
    setValues(initialValues(p));
    setError(null);
    setCreated(null);
  };

  const set = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }));

  const complete =
    provider !== null &&
    requiredKeys(provider).every((k) => (values[k] ?? '').trim().length > 0);

  const submit = async () => {
    if (!provider || !complete) return;
    const payload: Record<string, string> = {};
    for (const f of PROVIDER_CONNECTION_FIELDS[provider]) {
      const v = (values[f.key] ?? '').trim();
      if (v.length > 0) payload[f.key] = v;
    }
    setBusy(true);
    setError(null);
    const result = await createConnection(provider, payload);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'Could not create the connection.');
      return;
    }
    setCreated(`${PROVIDER_LABEL[provider]} connection created.`);
    setProvider(null);
    setValues({});
    // The instance lists above are rendered on the server.
    router.refresh();
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <h2 className="text-base font-semibold text-slate-900">Add a connection</h2>
      <p className="mt-1 text-sm text-slate-600">
        Connections belong to the organization — every board can build sources on them.
      </p>

      {created && <p className="mt-3 text-sm text-emerald-700">{created}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => choose(p)}
            // The four provider choices are one wrapping row, so they are
            // floored together. Measured 38px tall before.
            className={`inline-flex min-h-11 items-center rounded-md border px-3 py-1.5 text-sm md:min-h-0 ${
              provider === p
                ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                : 'border-slate-200 text-slate-700 hover:border-indigo-300'
            }`}
          >
            {PROVIDER_LABEL[p]}
          </button>
        ))}
      </div>

      {provider && (
        <div className="mt-4 space-y-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">
            New {PROVIDER_LABEL[provider]} connection
          </p>
          <TokenTutorial provider={provider} />
          {PROVIDER_CONNECTION_FIELDS[provider].map((f) => (
            <div key={f.key}>
              <label className="block text-[11px] text-slate-500" htmlFor={`new-conn-${f.key}`}>
                {f.label}
              </label>
              {f.type === 'select' ? (
                <select
                  id={`new-conn-${f.key}`}
                  aria-label={f.label}
                  className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs"
                  value={values[f.key] ?? f.options?.[0]?.value ?? ''}
                  onChange={(e) => set(f.key, e.target.value)}
                >
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`new-conn-${f.key}`}
                  aria-label={f.label}
                  type={f.type === 'password' ? 'password' : 'text'}
                  placeholder={f.placeholder}
                  className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-xs"
                  value={values[f.key] ?? ''}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
            </div>
          ))}

          {error && <p className="text-xs text-rose-600">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              className="inline-flex min-h-11 items-center rounded-md bg-indigo-600 px-3 py-1.5 text-xs text-white disabled:opacity-50 md:min-h-0"
              disabled={!complete || busy}
              onClick={submit}
            >
              {busy ? 'Creating…' : 'Create connection'}
            </button>
            <button
              type="button"
              className="inline-flex min-h-11 items-center rounded-md border border-slate-200 px-3 py-1.5 text-xs text-slate-600 md:min-h-0"
              onClick={() => {
                setProvider(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
