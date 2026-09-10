"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { Project } from "@deckgauge/shared";
import { useBodyScrollLock } from "@deckgauge/ui";
import { createProject, updateProject } from "../actions/projects";

const STATUS_OPTIONS = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "AT_RISK",
  "BLOCKED",
  "DONE",
] as const;

interface ProjectModalProps {
  project?: Project;
  boardId?: string;
  onClose: () => void;
}

export function ProjectModal({ project, boardId, onClose }: ProjectModalProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;

      const focusableElements = contentRef.current?.querySelectorAll(
        'input, select, textarea, button'
      ) as NodeListOf<HTMLElement> | undefined;

      if (!focusableElements || focusableElements.length === 0) return;

      const focusedElement = document.activeElement as HTMLElement;
      const focusedIndex = Array.from(focusableElements).indexOf(focusedElement);

      if (e.shiftKey) {
        e.preventDefault();
        const prevIndex = focusedIndex <= 0 ? focusableElements.length - 1 : focusedIndex - 1;
        focusableElements[prevIndex].focus();
      } else {
        e.preventDefault();
        const nextIndex = focusedIndex >= focusableElements.length - 1 ? 0 : focusedIndex + 1;
        focusableElements[nextIndex].focus();
      }
    };

    const modalContent = contentRef.current;
    modalContent?.addEventListener("keydown", handleKeyDown);
    return () => modalContent?.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Reference counted in `packages/ui`, deliberately. This used to clear
  // `overflow` unconditionally on unmount, which unlocked the page beneath any
  // other overlay that was still open.
  useBodyScrollLock(true);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) {
      onClose();
    }
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = {
      name: (form.elements.namedItem("name") as HTMLInputElement).value.trim(),
      owner: (form.elements.namedItem("owner") as HTMLInputElement).value.trim(),
      status: (form.elements.namedItem("status") as HTMLSelectElement).value,
      description: (form.elements.namedItem("description") as HTMLTextAreaElement).value.trim() || undefined,
    };

    if (!data.name) {
      setError("Name is required");
      return;
    }
    setError(null);

    const effectiveBoardId = boardId ?? project?.boardId ?? undefined;
    startTransition(async () => {
      try {
        if (project) {
          await updateProject(project.id, data, effectiveBoardId);
        } else {
          await createProject(data, effectiveBoardId);
        }
        onClose();
      } catch {
        setError("Something went wrong, please try again");
      }
    });
  };

  return (
    <div
      ref={overlayRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 animate-fade-in"
    >
      <div
        ref={contentRef}
        className="w-full max-w-md glass-elevated p-6 animate-slide-up"
      >
        <h2 className="mb-4 text-base font-semibold text-slate-800">
          {project ? "Edit project" : "New project"}
        </h2>
        <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Name <span className="text-red-600">*</span>
            </label>
            <input
              ref={nameInputRef}
              name="name"
              defaultValue={project?.name}
              className="input-dark"
              placeholder="Project name"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Owner <span className="text-red-600">*</span>
            </label>
            <input
              name="owner"
              defaultValue={project?.owner}
              className="input-dark"
              placeholder="Owner name"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Status
            </label>
            <select
              name="status"
              defaultValue={project?.status ?? "NOT_STARTED"}
              className="select-dark"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Description
            </label>
            <textarea
              name="description"
              defaultValue={project?.description ?? ""}
              rows={3}
              className="input-dark resize-none"
              placeholder="Optional description"
            />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn-ghost"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="btn-primary"
            >
              {isPending ? "Saving\u2026" : project ? "Save" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
