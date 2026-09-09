'use client';

import React, { useState } from 'react';
import type { JiraInstance } from './JiraInstanceManager';

interface JiraInstanceFormProps {
  instance: JiraInstance;
  isLoading: boolean;
  onSubmit: (instance: JiraInstance) => void;
  onCancel: () => void;
}

export function JiraInstanceForm({
  instance,
  isLoading,
  onSubmit,
  onCancel,
}: JiraInstanceFormProps) {
  const [formData, setFormData] = useState(instance);
  const [projectKeyInput, setProjectKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleAddProjectKey = () => {
    const key = projectKeyInput.trim().toUpperCase();
    if (!key) {
      setError('Project key cannot be empty');
      return;
    }
    if (formData.projectKeys.includes(key)) {
      setError(`${key} is already added`);
      return;
    }
    setFormData((prev: JiraInstance) => ({
      ...prev,
      projectKeys: [...prev.projectKeys, key],
    }));
    setProjectKeyInput('');
    setError(null);
  };

  const handleRemoveProjectKey = (key: string) => {
    setFormData((prev: JiraInstance) => ({
      ...prev,
      projectKeys: prev.projectKeys.filter((k: string) => k !== key),
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!formData.name.trim()) {
      setError('Instance name is required');
      return;
    }
    if (!formData.url.trim()) {
      setError('Jira URL is required');
      return;
    }
    if (!formData.email.trim()) {
      setError('Email is required');
      return;
    }
    if (!formData.token || !formData.token.trim()) {
      setError('API token is required');
      return;
    }
    if (formData.projectKeys.length === 0) {
      setError('At least one project key is required');
      return;
    }

    onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="glass p-6">
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}

      {/* Instance Name */}
      <div className="mb-4">
        <label htmlFor="name" className="block text-sm font-medium text-slate-600">
          Instance Name
        </label>
        <input
          type="text"
          id="name"
          value={formData.name}
          onChange={(e) =>
            setFormData((prev: JiraInstance) => ({ ...prev, name: e.target.value }))
          }
          placeholder="e.g., My Jira Cloud"
          className="input-dark mt-1"
          disabled={isLoading}
        />
      </div>

      {/* Jira URL */}
      <div className="mb-4">
        <label htmlFor="url" className="block text-sm font-medium text-slate-600">
          Jira Cloud URL
        </label>
        <input
          type="url"
          id="url"
          value={formData.url}
          onChange={(e) =>
            setFormData((prev: JiraInstance) => ({ ...prev, url: e.target.value }))
          }
          placeholder="https://your-domain.atlassian.net"
          className="input-dark mt-1"
          disabled={isLoading}
        />
      </div>

      {/* Email */}
      <div className="mb-4">
        <label htmlFor="email" className="block text-sm font-medium text-slate-600">
          Email
        </label>
        <input
          type="email"
          id="email"
          value={formData.email}
          onChange={(e) =>
            setFormData((prev: JiraInstance) => ({ ...prev, email: e.target.value }))
          }
          placeholder="your-email@example.com"
          className="input-dark mt-1"
          disabled={isLoading}
        />
      </div>

      {/* API Token */}
      <div className="mb-4">
        <label htmlFor="token" className="block text-sm font-medium text-slate-600">
          API Token
        </label>
        <input
          type="password"
          id="token"
          value={formData.token || ''}
          onChange={(e) =>
            setFormData((prev: JiraInstance) => ({ ...prev, token: e.target.value }))
          }
          placeholder="Your Atlassian API token"
          className="input-dark mt-1"
          disabled={isLoading}
        />
        <p className="mt-2 text-xs text-slate-500">
          Generate at{' '}
          <a
            href="https://id.atlassian.com/manage-profile/security/api-tokens"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-500 transition-colors"
          >
            id.atlassian.com
          </a>
        </p>
      </div>

      {/* Project Keys */}
      <div className="mb-6">
        <label htmlFor="projectKey" className="block text-sm font-medium text-slate-600">
          Project Keys
        </label>
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            id="projectKey"
            value={projectKeyInput}
            onChange={(e) => setProjectKeyInput(e.target.value)}
            onKeyPress={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddProjectKey();
              }
            }}
            placeholder="e.g., ORBIT"
            className="input-dark flex-1"
            disabled={isLoading}
          />
          <button
            type="button"
            onClick={handleAddProjectKey}
            disabled={isLoading}
            className="btn-secondary text-sm"
          >
            Add
          </button>
        </div>

        {formData.projectKeys.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {formData.projectKeys.map((key) => (
              <div
                key={key}
                className="inline-flex items-center gap-2 px-3 py-1 bg-indigo-50 text-blue-600 border border-indigo-200 rounded-full text-sm font-medium"
              >
                {key}
                <button
                  type="button"
                  onClick={() => handleRemoveProjectKey(key)}
                  disabled={isLoading}
                  className="text-blue-600 hover:text-blue-500 font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {"\u00D7"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Buttons */}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isLoading}
          className="btn-primary"
        >
          {isLoading ? 'Saving...' : 'Save Instance'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isLoading}
          className="btn-secondary"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
