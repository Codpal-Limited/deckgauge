'use client';

import { useEffect, useState, useTransition } from 'react';
import { SlideOverPanel, colorForValue, CommentEditor, CommentList, ColoredSelect } from '@deckgauge/ui';
import type { OrgEmployeeDto, UpdateEmployeeProfileInput } from '@deckgauge/shared';
import { lengthOfService } from '@deckgauge/shared';
import {
  getEmployeeActivity,
  updateEmployee,
  type EmployeeActivity,
} from '../../actions/org-trees';
import {
  getEmployeeComments,
  createEmployeeComment,
  updateEmployeeComment,
  deleteEmployeeComment,
} from '../../actions/employee-comments';
import { ActivityTables } from './ActivityTables';
import { RankingPanel } from './RankingPanel';

const EMPTY_ACTIVITY: EmployeeActivity = { commits: [], pullRequests: [], assignedIssues: [] };

type Tab = 'updates' | 'profile' | 'activity' | 'ranking';

interface Props {
  employee: OrgEmployeeDto;
  canEditSalary: boolean;
  defaultTab?: Tab;
  onClose: () => void;
  onSaved: () => void;
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-slate-400">{label}</span>
      <span className="text-slate-800 text-right">{value && value.length > 0 ? value : '—'}</span>
    </div>
  );
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

// EmployeeComment shape from the API — mapped to what CommentList expects
interface EmployeeCommentRow {
  id: string;
  orgEmployeeId: string;
  content: unknown;
  authorName: string;
  authorAvatar: string | null;
  pinned: boolean;
  isPrivate?: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}

// CommentList expects `projectId`; we satisfy it by aliasing orgEmployeeId
function toCommentListShape(c: EmployeeCommentRow) {
  return {
    id: c.id,
    projectId: c.orgEmployeeId,
    content: c.content,
    authorName: c.authorName,
    authorAvatar: c.authorAvatar,
    pinned: c.pinned,
    // Carried through so the row shows its own marker. The API only ever returns
    // a private comment to its author, so anything marked here is the reader's.
    isPrivate: c.isPrivate,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function EmployeeDetailDrawer({
  employee,
  canEditSalary,
  defaultTab,
  onClose,
  onSaved,
}: Props) {
  const [tab, setTab] = useState<Tab>(defaultTab ?? 'profile');
  const [activity, setActivity] = useState<EmployeeActivity>(EMPTY_ACTIVITY);
  const [comments, setComments] = useState<EmployeeCommentRow[]>([]);
  /** Per-note, and reset after each post — see handleCreateComment. */
  const [composePrivate, setComposePrivate] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [uploadIds, setUploadIds] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<UpdateEmployeeProfileInput>({});
  const [, startTransition] = useTransition();

  // Load activity on open
  useEffect(() => {
    let cancelled = false;
    setActivity(EMPTY_ACTIVITY);
    getEmployeeActivity(employee.id).then((a) => {
      if (!cancelled) setActivity(a);
    });
    return () => {
      cancelled = true;
    };
  }, [employee.id]);

  // Re-sync tab when the employee or defaultTab changes (e.g. user clicks a different employee's comment badge)
  useEffect(() => {
    setTab(defaultTab ?? 'profile');
  }, [defaultTab, employee.id]);

  // Load comments on mount and when employee changes
  useEffect(() => {
    loadComments();
    // reset comment state when employee changes
    setEditingCommentId(null);
    setUploadIds([]);
  }, [employee.id]);

  const loadComments = async () => {
    try {
      const data = await getEmployeeComments(employee.id);
      setComments(data);
    } catch {
      setComments([]);
    }
  };

  const handleCreateComment = (content: Record<string, unknown>) => {
    const currentUploadIds = [...uploadIds];
    const privateNote = composePrivate;
    setUploadIds([]);
    // Reset the toggle after posting: "private" is a decision about ONE note, and
    // a sticky toggle would silently make every following note private too.
    setComposePrivate(false);
    startTransition(async () => {
      await createEmployeeComment(employee.id, content, currentUploadIds, undefined, privateNote);
      await loadComments();
    });
  };

  const handleEditComment = (commentId: string) => {
    setEditingCommentId(commentId);
  };

  const handleSaveEdit = (commentId: string, content: Record<string, unknown>) => {
    startTransition(async () => {
      await updateEmployeeComment(employee.id, commentId, { content });
      setEditingCommentId(null);
      await loadComments();
    });
  };

  const handleDeleteComment = (commentId: string) => {
    startTransition(async () => {
      await deleteEmployeeComment(employee.id, commentId);
      await loadComments();
    });
  };

  const handleTogglePin = (commentId: string) => {
    const comment = comments.find((c) => c.id === commentId);
    if (!comment) return;
    startTransition(async () => {
      await updateEmployeeComment(employee.id, commentId, { pinned: !comment.pinned });
      await loadComments();
    });
  };

  const tenure = lengthOfService(employee.hireDate, new Date().toISOString());
  const tenureLabel = tenure ? `${tenure.years}y ${tenure.months}m ${tenure.days}d` : null;

  const setStr = (key: keyof UpdateEmployeeProfileInput, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value === '' ? null : value }));

  const save = () => {
    startTransition(async () => {
      await updateEmployee(employee.id, form);
      setEditing(false);
      onSaved();
    });
  };

  const avatarBg = colorForValue(employee.name);
  const initials = getInitials(employee.name);
  const displayTitle = employee.businessTitle ?? employee.role ?? '—';

  const TABS: { key: Tab; label: string }[] = [
    { key: 'updates', label: 'Updates' },
    { key: 'profile', label: 'Profile' },
    { key: 'activity', label: 'Activity' },
    { key: 'ranking', label: 'Ranking' },
  ];

  return (
    <SlideOverPanel isOpen={true} onClose={onClose} title={employee.name}>
      {/* Colored avatar header */}
      <div className="mb-4 flex items-start gap-3 pb-4 border-b border-slate-200">
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center text-white font-semibold text-lg shrink-0"
          style={{ backgroundColor: avatarBg }}
        >
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-base font-semibold text-slate-900 truncate">{employee.name}</div>
          <div className="text-sm text-slate-500">{displayTitle}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {employee.location && (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                📍 {employee.location}
              </span>
            )}
            {employee.employeeType && (
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {employee.employeeType}
              </span>
            )}
            {tenureLabel && (
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {tenureLabel}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Tab strip */}
      <div className="flex border-b border-slate-200 -mx-6 px-6 mb-4">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-4 py-3 text-sm font-medium transition-colors ${
              tab === key
                ? 'text-indigo-600 border-b-2 border-indigo-600'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Updates tab */}
      {tab === 'updates' && (
        <div className="-mx-6">
          <div className="px-5 pb-4">
            <CommentEditor
              onSubmit={handleCreateComment}
              orgEmployeeId={employee.id}
              boardId=""
              apiBaseUrl=""
              onUploadIdsChange={setUploadIds}
            />
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={composePrivate}
                onChange={(e) => setComposePrivate(e.target.checked)}
              />
              Private — only you can see this
            </label>
          </div>

          {editingCommentId && (
            <div className="px-5 pb-4 bg-slate-50 border-y border-slate-200">
              <p className="text-xs font-medium text-slate-500 py-2">Editing comment:</p>
              <CommentEditor
                initialContent={
                  comments.find((c) => c.id === editingCommentId)
                    ?.content as Record<string, unknown> | undefined
                }
                onSubmit={(content) => handleSaveEdit(editingCommentId, content)}
                onCancel={() => setEditingCommentId(null)}
                orgEmployeeId={employee.id}
                boardId=""
                apiBaseUrl=""
                onUploadIdsChange={() => {}}
              />
            </div>
          )}

          <CommentList
            comments={comments.map(toCommentListShape)}
            onEdit={handleEditComment}
            onDelete={handleDeleteComment}
            onTogglePin={handleTogglePin}
          />
        </div>
      )}

      {/* Profile tab */}
      {tab === 'profile' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                setForm({});
                setEditing((e) => !e);
              }}
              className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              {editing ? 'Cancel' : 'Edit'}
            </button>
          </div>

          {editing ? (
            <div className="space-y-2">
              <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
                Name and email are synced from the org chart and may be overwritten on the next sync.
              </p>
              <label className="block text-sm">
                <span className="text-slate-500">Name</span>
                <input
                  aria-label="Name"
                  defaultValue={employee.name}
                  onChange={(e) => setStr('name', e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-500">Business title</span>
                <input
                  defaultValue={employee.businessTitle ?? ''}
                  onChange={(e) => setStr('businessTitle', e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-500">Email</span>
                <input
                  aria-label="Email"
                  defaultValue={employee.email ?? ''}
                  onChange={(e) => setStr('email', e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-500">Phone</span>
                <input
                  defaultValue={employee.phone ?? ''}
                  onChange={(e) => setStr('phone', e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-500">Location</span>
                <input
                  defaultValue={employee.location ?? ''}
                  onChange={(e) => setStr('location', e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              <div className="text-sm">
                <span className="text-slate-500">Employee type</span>
                <div className="mt-0.5">
                  <ColoredSelect
                    ariaLabel="Employee type"
                    value={(form.employeeType as string | null | undefined) ?? employee.employeeType ?? ''}
                    options={['PERMANENT', 'CONTRACTOR']}
                    onChange={(v) =>
                      setForm((prev) => ({ ...prev, employeeType: v === '' ? null : (v as 'PERMANENT' | 'CONTRACTOR') }))
                    }
                  />
                </div>
              </div>
              <div className="text-sm">
                <span className="text-slate-500">Time type</span>
                <div className="mt-0.5">
                  <ColoredSelect
                    ariaLabel="Time type"
                    value={(form.timeType as string | null | undefined) ?? employee.timeType ?? ''}
                    options={['FULL_TIME', 'PART_TIME']}
                    onChange={(v) =>
                      setForm((prev) => ({ ...prev, timeType: v === '' ? null : (v as 'FULL_TIME' | 'PART_TIME') }))
                    }
                  />
                </div>
              </div>
              <label className="block text-sm">
                <span className="text-slate-500">Hire date</span>
                <input
                  type="date"
                  defaultValue={employee.hireDate?.slice(0, 10) ?? ''}
                  onChange={(e) => setStr('hireDate', e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-500">Work address</span>
                <input
                  defaultValue={employee.workAddress ?? ''}
                  onChange={(e) => setStr('workAddress', e.target.value)}
                  className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              {canEditSalary && (
                <label className="block text-sm">
                  <span className="text-slate-500">Salary</span>
                  <input
                    type="number"
                    defaultValue={employee.salaryCurrent ?? ''}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        salaryCurrent: e.target.value === '' ? null : Number(e.target.value),
                      }))
                    }
                    className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  />
                </label>
              )}
              <button
                type="button"
                onClick={save}
                className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700"
              >
                Save
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Summary section */}
              <div className="rounded-lg border border-slate-200 p-3">
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Summary
                </h4>
                <Field label="Business title" value={employee.businessTitle} />
                <Field label="Email" value={employee.email} />
                <Field label="Length of service" value={tenureLabel} />
              </div>

              {/* Job section */}
              <div className="rounded-lg border border-slate-200 p-3">
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Job
                </h4>
                <Field label="Employee ID" value={employee.employeeId} />
                <Field label="Business title" value={employee.businessTitle} />
                <Field label="Hire date" value={employee.hireDate?.slice(0, 10)} />
                <Field label="Employee type" value={employee.employeeType} />
                <Field label="Time type" value={employee.timeType} />
                <Field label="Location" value={employee.location} />
              </div>

              {/* Contact section */}
              <div className="rounded-lg border border-slate-200 p-3">
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Contact
                </h4>
                <Field label="Email" value={employee.email} />
                <Field label="Phone" value={employee.phone} />
                <Field label="Work address" value={employee.workAddress} />
              </div>

              {/* Compensation section */}
              <div className="rounded-lg border border-slate-200 p-3">
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Compensation
                </h4>
                {canEditSalary ? (
                  <Field
                    label="Current salary"
                    value={
                      employee.salaryCurrent != null
                        ? `${employee.salaryCurrent} ${employee.salaryCurrency ?? ''}`.trim()
                        : null
                    }
                  />
                ) : (
                  <p className="text-sm text-slate-400">Salary is restricted.</p>
                )}
                <p className="mt-2 text-xs text-slate-400">Salary history coming soon.</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Activity tab */}
      {tab === 'activity' && (
        <ActivityTables activity={activity} />
      )}

      {/* Ranking tab */}
      {tab === 'ranking' && <RankingPanel employee={employee} />}
    </SlideOverPanel>
  );
}
