'use client';
import { useId } from 'react';
import type { SourceInstanceRow } from '../../actions/connections';

/**
 * Issue #4 — the connection picker for the manual project/repo sync forms on
 * /sources. They used to take a free-text "instance uuid" that the UI displays
 * nowhere; this lists the connections the page already loads instead.
 *
 * Native <select>, matching AddConnectionPanel — there is no shared Select.
 */
interface Props {
  /** Accessible name, e.g. "Jira connection" — unique per panel on the page. */
  label: string;
  instances: SourceInstanceRow[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

/** The id to start the form with: the only connection when there is exactly one. */
export function defaultConnectionId(instances: SourceInstanceRow[]): string {
  return instances.length === 1 ? instances[0]!.id : '';
}

/**
 * How a sync table names its connection. Falls back to the id fragment the tables
 * used to show for a connection this caller cannot see (the instance list is
 * filtered by the API; the sync list may still reference others).
 */
export function connectionLabel(instances: SourceInstanceRow[], id: string): string {
  return instances.find((i) => i.id === id)?.label ?? id.slice(0, 8);
}

function optionText(instance: SourceInstanceRow): string {
  return instance.sublabel ? `${instance.label} — ${instance.sublabel}` : instance.label;
}

export function ConnectionSelect({ label, instances, value, onChange, disabled }: Props) {
  const id = useId();
  if (instances.length === 0) {
    return <p className="text-sm text-slate-500">Add a connection above first.</p>;
  }
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="rounded-md border border-slate-200 px-2 py-1.5 text-xs"
      >
        <option value="" disabled>
          Select connection…
        </option>
        {instances.map((instance) => (
          <option key={instance.id} value={instance.id}>
            {optionText(instance)}
          </option>
        ))}
      </select>
    </>
  );
}
