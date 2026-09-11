'use client';

import { useState } from 'react';
import type { StatusRuleDto } from '@deckgauge/shared';
import { saveStatusRules, type StatusRuleInput } from '../../actions/timesheet';
import { TableScroller } from '../../components/TableScroller';

interface EmployeeOption {
  id: string;
  name: string;
  role: string | null;
}

interface StatusRulesEditorProps {
  initialRules: StatusRuleDto[];
  roles: string[];
  employees: EmployeeOption[];
}

interface DraftRule {
  scope: 'ROLE' | 'EMPLOYEE';
  role: string | null;
  employeeId: string | null;
  statusesText: string;
}

function toDraft(r: StatusRuleDto): DraftRule {
  return { scope: r.scope, role: r.role, employeeId: r.employeeId, statusesText: r.inProgressStatuses.join(', ') };
}

function parseStatuses(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function StatusRulesEditor({ initialRules, roles, employees }: StatusRulesEditorProps) {
  const [drafts, setDrafts] = useState<DraftRule[]>(initialRules.map(toDraft));
  const [saving, setSaving] = useState(false);

  function update(index: number, patch: Partial<DraftRule>) {
    setDrafts((ds) => ds.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  function remove(index: number) {
    setDrafts((ds) => ds.filter((_, i) => i !== index));
  }

  function addRole() {
    setDrafts((ds) => [...ds, { scope: 'ROLE', role: roles[0] ?? '', employeeId: null, statusesText: '' }]);
  }

  function addEmployee() {
    setDrafts((ds) => [...ds, { scope: 'EMPLOYEE', role: null, employeeId: employees[0]?.id ?? '', statusesText: '' }]);
  }

  async function onSave() {
    setSaving(true);
    try {
      const rules: StatusRuleInput[] = drafts.map((d) => ({
        scope: d.scope,
        role: d.scope === 'ROLE' ? d.role : null,
        employeeId: d.scope === 'EMPLOYEE' ? d.employeeId : null,
        inProgressStatuses: parseStatuses(d.statusesText),
      }));
      await saveStatusRules(rules);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <TableScroller>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="px-2 py-1">Scope</th>
              <th className="px-2 py-1">Applies to</th>
              <th className="px-2 py-1">In-progress statuses (comma-separated)</th>
              <th className="px-2 py-1" />
            </tr>
          </thead>
          <tbody>
            {drafts.map((d, i) => (
              <tr key={i} data-testid="rule-row">
                <td className="px-2 py-1">{d.scope === 'ROLE' ? 'Role' : 'Person'}</td>
                <td className="px-2 py-1">
                  {d.scope === 'ROLE' ? (
                    <select aria-label="Role" value={d.role ?? ''} onChange={(e) => update(i, { role: e.target.value })}>
                      {roles.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <select aria-label="Employee" value={d.employeeId ?? ''} onChange={(e) => update(i, { employeeId: e.target.value })}>
                      {employees.map((emp) => (
                        <option key={emp.id} value={emp.id}>
                          {emp.name}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="px-2 py-1">
                  <input
                    aria-label="In-progress statuses"
                    className="w-full rounded border border-slate-200 px-2 py-1"
                    value={d.statusesText}
                    placeholder="In Progress, In QA"
                    onChange={(e) => update(i, { statusesText: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1">
                  <button
                    type="button"
                    aria-label="Remove rule"
                    onClick={() => remove(i)}
                    // 52x20 measured — a bare text button in a table cell. The
                    // whole row's other controls are inputs, which the touch
                    // invariant does not measure, so this is the only control
                    // here and has no sibling to strand.
                    className="min-h-11 text-slate-400 hover:text-red-500 md:min-h-0"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
      {/* Wraps: "Add role rule" + "Add employee override" + Save do not fit a
          390px phone on one line, and the row was clipping rather than
          scrolling. `ml-auto` on Save still right-aligns it once wrapped. */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={addRole}
          // All three buttons in this wrapping row are floored together — the
          // recurring defect on this plan is flooring one and stranding its
          // row-mates.
          className="min-h-11 rounded border border-slate-200 px-3 py-1 text-sm md:min-h-0"
        >
          Add role rule
        </button>
        <button
          type="button"
          onClick={addEmployee}
          className="min-h-11 rounded border border-slate-200 px-3 py-1 text-sm md:min-h-0"
        >
          Add employee override
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="ml-auto min-h-11 rounded bg-indigo-500 px-4 py-1 text-sm text-white disabled:opacity-50 md:min-h-0"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
