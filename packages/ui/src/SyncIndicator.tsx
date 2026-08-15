'use client';

import { useState } from 'react';

interface SyncIndicatorProps {
  className?: string;
}

export function SyncIndicator({ className = '' }: SyncIndicatorProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <span
      data-testid="sync-indicator"
      className={`relative inline-flex ${className}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-slate-300"
      >
        <path d="M21 2v6h-6" />
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
        <path d="M3 22v-6h6" />
        <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      </svg>
      {showTooltip && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs text-slate-50 bg-slate-700 rounded whitespace-nowrap z-50">
          Synced from Jira — updated on next sync
        </span>
      )}
    </span>
  );
}
