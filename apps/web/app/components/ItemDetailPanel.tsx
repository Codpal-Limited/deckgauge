"use client";

import { useState, useEffect, useTransition } from "react";
import { SlideOverPanel, CommentEditor, CommentList } from "@deckgauge/ui";
import type { Project, ProjectStatus, BoardColumn, Comment } from "@deckgauge/shared";
import { boardCapabilities, syncFieldSpec } from "@deckgauge/shared";
import {
  getComments,
  createComment,
  updateComment,
  deleteComment,
} from "../actions/comments";
import { OnboardControl } from "./OnboardControl";

const STATUS_OPTIONS: ProjectStatus[] = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "AT_RISK",
  "BLOCKED",
  "DONE",
];

interface ItemDetailPanelProps {
  project: Project & { fieldValues?: Record<string, string>; onboardedEmployeeId?: string | null };
  columns?: BoardColumn[];
  boardId?: string;
  boardKind?: string;
  onClose: () => void;
  onSave: (field: string, value: string) => void;
  /** which tab to open on first render (default "updates") */
  defaultTab?: "updates" | "details";
  /** existing board owner names for the Owner combobox (closed list + type-new) */
  owners?: string[];
  /**
   * A comment to scroll into view and highlight, from a notification's deep
   * link. Forwarded to `CommentList`, which owns the scroll.
   */
  targetCommentId?: string;
}

export function ItemDetailPanel({
  project,
  columns,
  boardId,
  boardKind,
  onClose,
  onSave,
  defaultTab = "updates",
  owners,
  targetCommentId,
}: ItemDetailPanelProps) {
  const canOnboard = !!boardId && boardCapabilities(boardKind ?? "").onboardTarget;
  const [activeTab, setActiveTab] = useState<"updates" | "details">(defaultTab);
  const [nameValue, setNameValue] = useState(project.name);
  const [ownerValue, setOwnerValue] = useState(project.owner);
  const [descValue, setDescValue] = useState(project.description || "");
  // Local copy of custom field values so controlled inputs (e.g. the Size
  // select) reflect a selection immediately — the project prop doesn't update.
  const [fieldVals, setFieldVals] = useState<Record<string, string>>(
    project.fieldValues ?? {},
  );
  const [comments, setComments] = useState<Comment[]>([]);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [uploadIds, setUploadIds] = useState<string[]>([]);

  // Reset the editable fields when a different item is opened — the panel
  // instance is reused, so useState initializers don't re-run on their own.
  useEffect(() => {
    setNameValue(project.name);
    setOwnerValue(project.owner);
    setDescValue(project.description || "");
    setFieldVals(project.fieldValues ?? {});
    // Reset only when a different item opens; keying on the (re-created each
    // render) field objects would clobber an in-progress edit.
  }, [project.id]);

  const saveField = (columnId: string, value: string) => {
    setFieldVals((prev) => ({ ...prev, [columnId]: value }));
    onSave(columnId, value);
  };

  useEffect(() => {
    loadComments();
  }, [project.id]);

  const loadComments = async () => {
    try {
      const data = await getComments(project.id);
      setComments(data);
    } catch {
      setComments([]);
    }
  };

  const handleCreateComment = (content: Record<string, unknown>) => {
    const currentUploadIds = [...uploadIds];
    setUploadIds([]);
    startTransition(async () => {
      await createComment(
        project.id,
        content,
        currentUploadIds,
        undefined,
        boardId,
      );
      await loadComments();
    });
  };

  const handleEditComment = (commentId: string) => {
    setEditingCommentId(commentId);
  };

  const handleSaveEdit = (commentId: string, content: Record<string, unknown>) => {
    startTransition(async () => {
      await updateComment(project.id, commentId, { content }, boardId);
      setEditingCommentId(null);
      await loadComments();
    });
  };

  const handleDeleteComment = (commentId: string) => {
    startTransition(async () => {
      await deleteComment(project.id, commentId, boardId);
      await loadComments();
    });
  };

  const handleTogglePin = (commentId: string) => {
    const comment = comments.find((c) => c.id === commentId);
    if (!comment) return;
    startTransition(async () => {
      await updateComment(
        project.id,
        commentId,
        { pinned: !comment.pinned },
        boardId,
      );
      await loadComments();
    });
  };

  return (
    <SlideOverPanel isOpen onClose={onClose} title={project.name}>
      {/* Tabs */}
      <div className="flex border-b border-slate-200 -mx-6 -mt-5 px-6 mb-4">
        <button
          type="button"
          onClick={() => setActiveTab("updates")}
          className={`px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === "updates"
              ? "text-indigo-600 border-b-2 border-indigo-600"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Updates
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("details")}
          className={`px-4 py-3 text-sm font-medium transition-colors ${
            activeTab === "details"
              ? "text-indigo-600 border-b-2 border-indigo-600"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Details
        </button>
      </div>

      {activeTab === "updates" && (
        <div className="-mx-6">
          {/* New comment editor */}
          <div className="px-5 pb-4">
            <CommentEditor
              onSubmit={handleCreateComment}
              projectId={project.id}
              boardId={boardId ?? ''}
              apiBaseUrl=""
              onUploadIdsChange={setUploadIds}
            />
          </div>

          {/* Edit mode for a specific comment */}
          {editingCommentId && (
            <div className="px-5 pb-4 bg-slate-50 border-y border-slate-200">
              <p className="text-xs font-medium text-slate-500 py-2">
                Editing comment:
              </p>
              <CommentEditor
                initialContent={
                  comments.find((c) => c.id === editingCommentId)
                    ?.content as Record<string, unknown> | undefined
                }
                onSubmit={(content) =>
                  handleSaveEdit(editingCommentId, content)
                }
                onCancel={() => setEditingCommentId(null)}
                projectId={project.id}
                boardId={boardId ?? ''}
                apiBaseUrl=""
                onUploadIdsChange={() => {}}
              />
            </div>
          )}

          {/* Comment list */}
          <CommentList
            comments={comments}
            onEdit={handleEditComment}
            onDelete={handleDeleteComment}
            onTogglePin={handleTogglePin}
            targetCommentId={targetCommentId}
          />
        </div>
      )}

      {activeTab === "details" && (
        <div className="space-y-5">
          {/* Onboard to org tree — recruitment boards only */}
          {canOnboard && boardId && (
            <OnboardControl
              boardId={boardId}
              projectId={project.id}
              onboardedEmployeeId={project.onboardedEmployeeId}
            />
          )}
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Name
            </label>
            <input
              type="text"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={() => {
                if (nameValue.trim() && nameValue !== project.name)
                  onSave("name", nameValue.trim());
              }}
              className="input-dark"
            />
          </div>

          {/* Owner — closed list of existing board owners + type a new name */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Owner
            </label>
            <input
              type="text"
              list="item-owner-options"
              value={ownerValue}
              placeholder="Select or type an owner"
              onChange={(e) => setOwnerValue(e.target.value)}
              onBlur={() => {
                const next = ownerValue.trim();
                // Owner must be non-empty (server requires it); skip empty saves.
                if (next && next !== project.owner) onSave("owner", next);
              }}
              className="input-dark"
            />
            {owners && owners.length > 0 && (
              <datalist id="item-owner-options">
                {owners.map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>
            )}
          </div>

          {/* Manual edits — every field a manual edit has taken over from sync,
              each revertable back to the value the source last supplied. */}
          {(project.overriddenFields ?? []).length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50/50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-amber-900">Manual edits</span>
                {(project.overriddenFields ?? []).length > 1 && (
                  <button
                    type="button"
                    aria-label="Revert all manual edits"
                    onClick={() => onSave("revertAllFields", "")}
                    className="text-xs text-indigo-600 hover:text-indigo-700"
                  >
                    {"\u21BA"} Revert all
                  </button>
                )}
              </div>
              <ul className="space-y-1">
                {(project.overriddenFields ?? []).map((key) => {
                  const label = syncFieldSpec(key)?.label ?? key;
                  const snapshot = (project.preOverrideValues ?? {})[key];
                  const shown =
                    snapshot == null || snapshot === "" ? "empty" : String(snapshot);
                  return (
                    <li key={key} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate text-slate-700">
                        {label} — synced value was{" "}
                        <span className="font-medium text-slate-900">{shown}</span>
                      </span>
                      <button
                        type="button"
                        aria-label={`Revert ${label}`}
                        onClick={() => onSave("revertField", key)}
                        className="shrink-0 text-indigo-600 hover:text-indigo-700"
                      >
                        {"\u21BA"} Revert
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Assignee — read-only synced source person */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Assignee
            </label>
            <p className="text-sm text-slate-300">{project.assignee?.trim() || "—"}</p>
          </div>

          {/* Status */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Status
            </label>
            <select
              value={project.status}
              onChange={(e) => onSave("status", e.target.value)}
              className="select-dark"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>

          {/* Start Date */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Start Date
            </label>
            <input
              type="date"
              value={project.startDate ? new Date(project.startDate).toISOString().slice(0, 10) : ''}
              onChange={(e) => onSave('startDate', e.target.value)}
              className="input-dark"
            />
          </div>

          {/* End Date */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              End Date
            </label>
            <input
              type="date"
              value={project.endDate ? new Date(project.endDate).toISOString().slice(0, 10) : ''}
              onChange={(e) => onSave('endDate', e.target.value)}
              className="input-dark"
            />
          </div>

          {/* Duration */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Duration
            </label>
            <input
              type="text"
              defaultValue={project.durationCode ?? ''}
              onBlur={(e) => onSave('durationCode', e.target.value.trim())}
              placeholder="e.g. 2w"
              className="input-dark"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Description
            </label>
            <textarea
              rows={4}
              value={descValue}
              onChange={(e) => setDescValue(e.target.value)}
              onBlur={() => {
                if (descValue !== (project.description || ""))
                  onSave("description", descValue);
              }}
              className="input-dark resize-none"
              placeholder="Add a description..."
            />
          </div>

          {/* Custom columns */}
          {columns?.map((col) => (
            <div key={col.id}>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                {col.name}
              </label>
              {col.type === "CHECKBOX" ? (
                <input
                  type="checkbox"
                  checked={fieldVals[col.id] === "true"}
                  onChange={(e) =>
                    saveField(col.id, e.target.checked ? "true" : "false")
                  }
                  className="h-4 w-4 rounded border-slate-300 bg-white text-indigo-500 focus:ring-indigo-500/20"
                />
              ) : col.type === "DROPDOWN" || col.type === "STATUS" ? (
                <select
                  value={fieldVals[col.id] || ""}
                  onChange={(e) => saveField(col.id, e.target.value)}
                  className="select-dark"
                >
                  <option value="">-- Select --</option>
                  {(
                    (col.config as Record<string, unknown> | null)
                      ?.options as string[] | undefined
                  )?.map((opt: string) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : col.type === "DATE" ? (
                <input
                  type="date"
                  value={fieldVals[col.id] || ""}
                  onChange={(e) => saveField(col.id, e.target.value)}
                  className="input-dark"
                />
              ) : col.type === "NUMBER" ? (
                <input
                  type="number"
                  value={fieldVals[col.id] || ""}
                  onChange={(e) => saveField(col.id, e.target.value)}
                  className="input-dark"
                />
              ) : (
                <input
                  type="text"
                  value={fieldVals[col.id] || ""}
                  onChange={(e) => setFieldVals((p) => ({ ...p, [col.id]: e.target.value }))}
                  onBlur={(e) => saveField(col.id, e.target.value)}
                  className="input-dark"
                />
              )}
            </div>
          ))}

          {/* Timestamps */}
          <div className="border-t border-slate-200 pt-4 text-xs text-slate-500">
            <p>Created: {new Date(project.createdAt).toLocaleString()}</p>
            <p>Updated: {new Date(project.updatedAt).toLocaleString()}</p>
          </div>
        </div>
      )}
    </SlideOverPanel>
  );
}
