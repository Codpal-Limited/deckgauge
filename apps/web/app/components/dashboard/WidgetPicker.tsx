'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  WIDGET_SCOPE_REQUIREMENTS,
  widgetIsSupportedByScope,
  type NewWidgetType,
  type WidgetCategory,
  type WidgetScopeFlags,
  type WidgetSubject,
  type WidgetSourceKind,
} from '@deckgauge/shared';
import { createWidget } from '../../actions/widgets';
import { fetchWidgetScope } from '../../actions/widget-scope';
import { WIDGET_CATALOG, WidgetDefinition } from './widgetRegistry';

interface WidgetPickerProps {
  boardId: string;
  viewId: string;
  onClose: () => void;
  onAdded: () => void;
}

const SOURCE_LABELS: Record<WidgetSourceKind, string> = {
  jira: 'Jira',
  ado: 'Azure DevOps',
  github: 'GitHub',
  gitlab: 'GitLab',
};

function formatRequirementMessage(widgetType: string): string | null {
  const required = WIDGET_SCOPE_REQUIREMENTS[widgetType as NewWidgetType];
  if (!required) return null;
  const labels = required.map((k) => SOURCE_LABELS[k]);
  if (labels.length === 1) return `Needs ${labels[0]}.`;
  if (labels.length === 2) return `Needs ${labels[0]} or ${labels[1]}.`;
  return `Needs ${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}.`;
}

function isWidgetSupported(widget: WidgetDefinition, scope: WidgetScopeFlags | null): boolean {
  if (!scope) return true;
  if (!(widget.type in WIDGET_SCOPE_REQUIREMENTS)) return true;
  return widgetIsSupportedByScope(widget.type as NewWidgetType, scope);
}

const SUBJECT_ORDER: Array<{ key: WidgetSubject; label: string }> = [
  { key: 'pull_requests', label: 'Pull Requests' },
  { key: 'issues', label: 'Issues' },
  { key: 'commits', label: 'Commits' },
  { key: 'board_state', label: 'Board State' },
];

const CATEGORY_CHIP: Record<WidgetCategory, string> = {
  'board-health': 'bg-slate-100 text-slate-700',
  flow: 'bg-cyan-100 text-cyan-700',
  speed: 'bg-emerald-100 text-emerald-700',
  quality: 'bg-amber-100 text-amber-700',
  planning: 'bg-indigo-100 text-indigo-700',
  correlation: 'bg-fuchsia-100 text-fuchsia-700',
  ai: 'bg-violet-100 text-violet-700',
  comparison: 'bg-blue-100 text-blue-700',
  focus: 'bg-rose-100 text-rose-700',
};

export default function WidgetPicker({ boardId, viewId, onClose, onAdded }: WidgetPickerProps) {
  const [isPending, startTransition] = useTransition();
  const [scope, setScope] = useState<WidgetScopeFlags | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWidgetScope(boardId)
      .then((s) => {
        if (!cancelled) setScope(s);
      })
      .catch(() => {
        // Fall back to no-gating on fetch failure so the picker stays usable.
        if (!cancelled) {
          setScope({ hasJira: true, hasGitHub: true, hasGitLab: true, hasAdo: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  const handleAdd = (widget: WidgetDefinition) => {
    const defaultConfig: Record<string, unknown> = {};
    for (const field of widget.configFields ?? []) {
      defaultConfig[field.key] = field.default;
    }

    startTransition(async () => {
      await createWidget(boardId, viewId, {
        widgetType: widget.type,
        title: widget.label,
        config: defaultConfig,
        layout: { x: 0, y: 0, ...widget.defaultSize },
      });
      onAdded();
      onClose();
    });
  };

  const grouped = SUBJECT_ORDER.map((s) => ({
    ...s,
    // Comparison widgets live only on standalone Comparisons; never offer them
    // in a board's dashboard picker.
    widgets: WIDGET_CATALOG.filter((w) => w.subject === s.key && !w.requiresComparisonView),
  }));

  return (
    <div
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-800">Add Widget</h2>
          <button className="text-slate-400 hover:text-slate-600" onClick={onClose}>
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-5">
          {grouped.map((g) =>
            g.widgets.length ? (
              <section key={g.key}>
                <h3 className="text-xs font-semibold uppercase text-slate-500 mb-2">
                  {g.label} ({g.widgets.length})
                </h3>
                <ul className="space-y-1">
                  {g.widgets.map((w) => {
                    const supported = isWidgetSupported(w, scope);
                    const reason = supported ? null : formatRequirementMessage(w.type);
                    return (
                      <li
                        key={w.type}
                        data-widget-type={w.type}
                        className={`flex items-center justify-between rounded border border-slate-200 px-3 py-2 ${
                          supported ? 'hover:bg-slate-50' : 'bg-slate-50/60'
                        }`}
                      >
                        <div className="min-w-0">
                          <p
                            className={`text-sm font-medium ${
                              supported ? 'text-slate-800' : 'text-slate-500'
                            }`}
                          >
                            {w.label}
                          </p>
                          <p className="text-xs text-slate-500 truncate">{w.description}</p>
                          {reason && (
                            <p
                              data-unsupported-reason
                              className="text-[11px] text-amber-700 mt-0.5"
                            >
                              {reason}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            data-category-chip
                            className={`text-[10px] rounded px-1.5 py-0.5 ${CATEGORY_CHIP[w.category]}`}
                          >
                            {w.category}
                          </span>
                          <button
                            type="button"
                            data-action="add"
                            onClick={() => handleAdd(w)}
                            disabled={isPending || !supported}
                            title={reason ?? undefined}
                            className="text-xs text-indigo-600 hover:underline disabled:text-slate-400 disabled:no-underline disabled:cursor-not-allowed"
                          >
                            Add
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null
          )}
        </div>
      </div>
    </div>
  );
}
