'use client';

import { useState } from 'react';
import { JiraInstanceForm } from './JiraInstanceForm';
import type { JiraInstance } from './JiraInstanceManager';

interface JiraInstanceCardProps {
  instance: JiraInstance;
  isEditing: boolean;
  isLoading: boolean;
  onEdit: () => void;
  onTest: () => void;
  onRemove: () => void;
  onSave: (instance: Omit<JiraInstance, 'id' | 'createdAt'> & { id?: string }) => void;
  onCancel: () => void;
}

export function JiraInstanceCard({
  instance,
  isEditing,
  isLoading,
  onEdit,
  onTest,
  onRemove,
  onSave,
  onCancel,
}: JiraInstanceCardProps) {
  const [revealToken, setRevealToken] = useState(false);

  if (isEditing) {
    return (
      <JiraInstanceForm
        instance={instance}
        isLoading={isLoading}
        onSubmit={onSave}
        onCancel={onCancel}
      />
    );
  }

  return (
    <div className="glass p-6 hover:border-slate-300 transition-all">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h4 className="text-base font-medium text-slate-800">{instance.name}</h4>
          <p className="text-sm text-slate-500 mt-1">{instance.url}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onEdit}
            disabled={isLoading}
            className="btn-secondary text-sm py-1.5"
          >
            Edit
          </button>
          <button
            onClick={onRemove}
            disabled={isLoading}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-red-50 border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed md:min-h-0"
          >
            Remove
          </button>
        </div>
      </div>

      {/* Details */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">
            Email
          </label>
          <p className="mt-1 text-sm text-slate-700">{instance.email}</p>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">
            API Token
          </label>
          <div className="mt-1 flex items-center gap-2">
            <code className="text-sm font-mono text-slate-400">
              {revealToken && instance.token && instance.token !== '***'
                ? instance.token
                : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
            </code>
            <button
              onClick={() => setRevealToken(!revealToken)}
              className="text-xs text-blue-600 hover:text-blue-500 font-medium transition-colors"
            >
              {revealToken ? 'Hide' : 'Reveal'}
            </button>
          </div>
        </div>
      </div>

      {/* Project Keys */}
      <div className="mb-4">
        <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide">
          Project Keys ({instance.projectKeys.length})
        </label>
        {instance.projectKeys.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {instance.projectKeys.map((key) => (
              <span
                key={key}
                className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-blue-600 border border-indigo-200"
              >
                {key}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-sm text-slate-500">No project keys configured</p>
        )}
      </div>

      {/* Test Connection Button */}
      <div className="flex gap-2">
        <button
          onClick={onTest}
          disabled={isLoading}
          className="btn-primary text-sm py-1.5"
        >
          {isLoading ? 'Testing...' : 'Test Connection'}
        </button>
      </div>
    </div>
  );
}
