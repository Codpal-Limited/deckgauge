'use client';

import { useEffect, useMemo, useState } from 'react';
import { CURATED_JIRA_FIELDS, type DiscoveredJiraField } from '@deckgauge/shared';
import {
  listJiraSourceFields,
  attachJiraSourceField,
  detachJiraSourceField,
} from '../../actions/jira';

interface Props {
  boardId: string;
  sourceId: string;
  /** fieldId -> columnId, already mapped on this source. */
  fieldMappings: Record<string, string>;
  // Notifies the parent card that a field was attached or detached, so it can
  // refetch whatever depends on the new/removed column. The two carry
  // different follow-ups for the parent: an attach creates an empty column
  // that needs a sync to populate, a detach only removes a mapping and
  // leaves the column (and its values) untouched, so the parent needs to
  // know which one happened rather than just "something changed".
  onChange: (kind: 'attach' | 'detach') => void;
}

/**
 * Curated fields sort matching names to the top of the (unfiltered) picker.
 * Matched on NAME only, never on the hardcoded id — `customfield_10016` in
 * CURATED_JIRA_FIELDS is instance-specific and very likely wrong for any given
 * Jira instance; live discovery already returns the correct id.
 */
function curatedRank(name: string): number {
  const idx = CURATED_JIRA_FIELDS.findIndex(
    (f) => f.label.toLowerCase() === name.toLowerCase(),
  );
  return idx === -1 ? CURATED_JIRA_FIELDS.length : idx;
}

/**
 * Supported-first, then curated rank, then name. `SourceFieldsService`
 * already returns fields supported-first; sorting by curatedRank alone
 * discarded that, so an unsupported curated field (disabled, unclickable)
 * could surface ahead of a supported non-curated one — the worst position
 * for it, since it's the first thing the user sees and can't pick.
 */
function compareFields(a: DiscoveredJiraField, b: DiscoveredJiraField): number {
  if (a.supported !== b.supported) return a.supported ? -1 : 1;
  const rankDiff = curatedRank(a.name) - curatedRank(b.name);
  if (rankDiff !== 0) return rankDiff;
  return a.name.localeCompare(b.name);
}

export function FieldMappingEditor({ boardId, sourceId, fieldMappings, onChange }: Props) {
  const [fields, setFields] = useState<DiscoveredJiraField[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Seeded once from the initial prop, not kept in sync with it afterwards:
  // once the user attaches or removes a field this local copy becomes the
  // source of truth for this mount, and re-deriving it from `fieldMappings`
  // on every render would fight that (or silently discard it, if the parent
  // ever passes a fresh object with the same contents). If the parent needs
  // to force a reset — e.g. a different source is now shown here — it should
  // remount this component with a new `key`.
  const [mapped, setMapped] = useState<Record<string, string>>(fieldMappings);
  const [query, setQuery] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    listJiraSourceFields(boardId, sourceId)
      .then((res) => setFields(res.fields))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Failed to load Jira fields'),
      )
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [boardId, sourceId]);

  const orderedFields = useMemo(() => {
    if (!fields) return [];
    return [...fields].sort(compareFields);
  }, [fields]);

  const visibleFields = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orderedFields.filter(
      (f) => !(f.id in mapped) && (q === '' || f.name.toLowerCase().includes(q)),
    );
  }, [orderedFields, mapped, query]);

  // Driven off `mapped` (not `fields`), so a mapping survives here even when
  // discovery no longer returns it — e.g. a custom field deleted upstream in
  // Jira, exactly the case the backend's fieldMappings design is meant to
  // survive. Falls back to the raw id as the label so the chip (and its
  // Remove button) still renders instead of the mapping silently becoming
  // unremovable from this UI.
  const mappedChips = useMemo(() => {
    return Object.keys(mapped).map((fieldId) => ({
      id: fieldId,
      name: fields?.find((f) => f.id === fieldId)?.name ?? fieldId,
    }));
  }, [fields, mapped]);

  async function handlePick(field: DiscoveredJiraField) {
    const columnType = field.columnType;
    if (!field.supported || columnType === null) return;
    setActionError(null);
    try {
      const { columnId } = await attachJiraSourceField(boardId, sourceId, {
        fieldId: field.id,
        name: field.name,
        columnType,
        multiValue: field.multiValue,
      });
      setMapped((prev) => ({ ...prev, [field.id]: columnId }));
      setQuery('');
      onChange('attach');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add the field');
    }
  }

  async function handleRemove(fieldId: string) {
    setActionError(null);
    try {
      await detachJiraSourceField(boardId, sourceId, fieldId);
      setMapped((prev) => {
        const next = { ...prev };
        delete next[fieldId];
        return next;
      });
      onChange('detach');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to remove the field');
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-[10px] uppercase tracking-wider font-bold text-indigo-700 mb-2">
        Field mapping
      </div>

      {loading && (
        <div className="p-3 text-center text-xs text-slate-500">Loading Jira fields…</div>
      )}

      {!loading && error && (
        <div className="p-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md flex items-center gap-2">
          <span>Couldn&apos;t load fields.</span>
          <button
            type="button"
            onClick={load}
            className="text-indigo-600 hover:underline font-medium"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-2">
          {actionError && (
            <div
              role="alert"
              className="p-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md"
            >
              {actionError}
            </div>
          )}

          {mappedChips.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {mappedChips.map((f) => (
                <span
                  key={f.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-indigo-50 text-indigo-700"
                >
                  {f.name}
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    className="text-indigo-400 hover:text-indigo-700"
                    onClick={() => handleRemove(f.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <input
            role="combobox"
            aria-expanded="true"
            aria-controls="jira-field-mapping-listbox"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="+ field"
            className="text-xs px-2 py-1 rounded-md border border-dashed border-slate-300 bg-slate-50 text-slate-700 focus:outline-none focus:border-indigo-300 w-full max-w-xs"
          />

          <ul
            id="jira-field-mapping-listbox"
            role="listbox"
            aria-label="Jira fields"
            className="border border-slate-200 rounded-md divide-y divide-slate-100 max-h-56 overflow-y-auto bg-white"
          >
            {visibleFields.length === 0 && (
              <li className="px-2 py-2 text-xs text-slate-400">No matching fields</li>
            )}
            {visibleFields.map((f) => (
              <li
                key={f.id}
                role="option"
                aria-selected="false"
                aria-disabled={!f.supported}
                onClick={() => handlePick(f)}
                className={`px-2 py-1.5 text-xs flex items-center justify-between gap-2 ${
                  f.supported
                    ? 'cursor-pointer hover:bg-slate-50 text-slate-900'
                    : 'cursor-not-allowed text-slate-400'
                }`}
              >
                <span>{f.name}</span>
                {!f.supported && f.unsupportedReason && (
                  <span className="text-rose-500 text-[10px]">{f.unsupportedReason}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
