'use client';

import { useState } from 'react';
import type { AdvisorConfigInput } from '@deckgauge/shared';
import {
  saveAdvisorConfig,
  testAdvisorConfig,
  type AdvisorConfigStatus,
  type TestAdvisorConfigResult,
} from '../../actions/advisor';

interface AdvisorSettingsClientProps {
  initialConfig: AdvisorConfigStatus;
}

type ProviderChoice = 'hosted' | 'anthropic' | 'ollama';

const DATA_HANDLING_COPY: Record<ProviderChoice, string> = {
  hosted:
    'Board metrics are sent to Deckgauge Cloud (which relays to Claude) on each question.',
  anthropic: "Board metrics are sent to Anthropic's API on each question.",
  ollama: 'Everything stays on your infrastructure — nothing leaves your network.',
};

function initialProvider(config: AdvisorConfigStatus): ProviderChoice | null {
  return config.configured ? config.provider : null;
}

export function AdvisorSettingsClient({ initialConfig }: AdvisorSettingsClientProps) {
  const [selectedProvider, setSelectedProvider] = useState<ProviderChoice | null>(
    initialProvider(initialConfig),
  );
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(
    initialConfig.configured ? initialConfig.model : '',
  );
  const [baseUrl, setBaseUrl] = useState(
    initialConfig.configured && initialConfig.provider === 'ollama' ? initialConfig.baseUrl : '',
  );
  const [hasApiKey, setHasApiKey] = useState(
    initialConfig.configured && initialConfig.provider === 'anthropic'
      ? initialConfig.hasApiKey
      : false,
  );
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestAdvisorConfigResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function selectProvider(provider: ProviderChoice) {
    if (provider === 'hosted') return; // disabled in the OSS build
    setSelectedProvider(provider);
    setTestResult(null);
    setSaveError(null);
    setSaved(false);
  }

  function onFieldChange(setter: (v: string) => void) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setter(e.target.value);
      setTestResult(null);
      setSaved(false);
    };
  }

  function buildInput(): AdvisorConfigInput | null {
    if (selectedProvider === 'anthropic') {
      if (!apiKey.trim() || !model.trim()) return null;
      return { provider: 'anthropic', apiKey: apiKey.trim(), model: model.trim() };
    }
    if (selectedProvider === 'ollama') {
      if (!baseUrl.trim() || !model.trim()) return null;
      return { provider: 'ollama', baseUrl: baseUrl.trim(), model: model.trim() };
    }
    return null;
  }

  const input = buildInput();

  async function onTest() {
    if (!input) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testAdvisorConfig(input);
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  }

  async function onSave() {
    if (!input) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const result = await saveAdvisorConfig(input);
      if (result.ok) {
        setSaved(true);
        if (input.provider === 'anthropic') setHasApiKey(true);
      } else {
        setSaveError(result.error);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <ProviderCard
          title="Deckgauge Hosted"
          description="Zero-setup Claude — no key to paste."
          badge="Available on Deckgauge Cloud"
          selected={false}
          disabled
          onSelect={() => selectProvider('hosted')}
        />
        <ProviderCard
          title="Your own API key"
          description="Anthropic — bring your own key."
          selected={selectedProvider === 'anthropic'}
          onSelect={() => selectProvider('anthropic')}
        />
        <ProviderCard
          title="Local Ollama"
          description="Runs entirely on your own infrastructure."
          selected={selectedProvider === 'ollama'}
          onSelect={() => selectProvider('ollama')}
        />
      </div>

      {selectedProvider === 'anthropic' && (
        <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-1">
            <label htmlFor="advisor-api-key" className="text-sm font-medium text-slate-700">
              API key
            </label>
            <input
              id="advisor-api-key"
              type="password"
              autoComplete="off"
              className="w-full rounded border border-slate-200 px-3 py-2 text-sm"
              placeholder={hasApiKey ? 'A key is already saved — enter a new one to replace it' : 'sk-ant-...'}
              value={apiKey}
              onChange={onFieldChange(setApiKey)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="advisor-anthropic-model" className="text-sm font-medium text-slate-700">
              Model
            </label>
            <input
              id="advisor-anthropic-model"
              type="text"
              className="w-full rounded border border-slate-200 px-3 py-2 text-sm"
              placeholder="claude-haiku-4-5"
              value={model}
              onChange={onFieldChange(setModel)}
            />
          </div>
        </div>
      )}

      {selectedProvider === 'ollama' && (
        <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-1">
            <label htmlFor="advisor-base-url" className="text-sm font-medium text-slate-700">
              Base URL
            </label>
            <input
              id="advisor-base-url"
              type="text"
              className="w-full rounded border border-slate-200 px-3 py-2 text-sm"
              placeholder="http://localhost:11434"
              value={baseUrl}
              onChange={onFieldChange(setBaseUrl)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="advisor-ollama-model" className="text-sm font-medium text-slate-700">
              Model
            </label>
            <input
              id="advisor-ollama-model"
              type="text"
              className="w-full rounded border border-slate-200 px-3 py-2 text-sm"
              placeholder="llama3.2"
              value={model}
              onChange={onFieldChange(setModel)}
            />
          </div>
        </div>
      )}

      {selectedProvider && (
        <>
          <p className="text-xs text-slate-500">{DATA_HANDLING_COPY[selectedProvider]}</p>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onTest}
              disabled={!input || testing}
              className="rounded border border-indigo-500 px-4 py-1.5 text-sm text-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!input || saving}
              className="rounded bg-indigo-500 px-4 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>

            {testResult && (
              <span
                role="status"
                className={
                  testResult.ok
                    ? 'inline-flex items-center gap-1 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200'
                    : 'inline-flex items-center gap-1 rounded-full bg-rose-50 px-3 py-1 text-xs font-medium text-rose-700 ring-1 ring-rose-200'
                }
              >
                {testResult.ok
                  ? `Connected — ${testResult.model}${
                      testResult.latencyMs !== undefined ? ` (${testResult.latencyMs}ms)` : ''
                    }`
                  : testResult.error ?? 'Connection failed'}
              </span>
            )}
          </div>

          {saved && (
            <p className="text-sm font-medium text-emerald-600" role="status">
              Saved.
            </p>
          )}
          {saveError && (
            <p className="text-sm font-medium text-rose-600" role="alert">
              {saveError}
            </p>
          )}
        </>
      )}
    </div>
  );
}

interface ProviderCardProps {
  title: string;
  description: string;
  badge?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

function ProviderCard({ title, description, badge, selected, disabled, onSelect }: ProviderCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={`flex flex-col items-start gap-1 rounded-lg border p-4 text-left shadow-sm transition-colors ${
        disabled
          ? 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-60'
          : selected
            ? 'border-indigo-500 bg-indigo-50'
            : 'border-slate-200 bg-white hover:border-indigo-300'
      }`}
    >
      <span className="text-sm font-semibold text-slate-900">{title}</span>
      <span className="text-xs text-slate-500">{description}</span>
      {badge && (
        <span className="mt-1 inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600">
          {badge}
        </span>
      )}
    </button>
  );
}
