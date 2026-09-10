"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { ColumnType } from "@deckgauge/shared";
import { useBodyScrollLock } from "@deckgauge/ui";
import { createColumn } from "../actions/projects";

const COLUMN_TYPES = [
  { value: "TEXT", label: "Text", icon: "Aa" },
  { value: "STATUS", label: "Status", icon: "\u25D1" },
  { value: "DATE", label: "Date", icon: "\uD83D\uDCC5" },
  { value: "NUMBER", label: "Number", icon: "#" },
  { value: "CHECKBOX", label: "Checkbox", icon: "\u2611" },
  { value: "DROPDOWN", label: "Dropdown", icon: "\u25BE" },
  { value: "PERSON", label: "Person", icon: "\uD83D\uDC64" },
  { value: "LINK", label: "Link", icon: "\uD83D\uDD17" },
] as const;

interface ColumnManagerProps {
  boardId: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export function ColumnManager({
  boardId,
  onClose,
  onSuccess,
}: ColumnManagerProps) {
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
        const prevIndex =
          focusedIndex <= 0 ? focusableElements.length - 1 : focusedIndex - 1;
        focusableElements[prevIndex].focus();
      } else {
        e.preventDefault();
        const nextIndex =
          focusedIndex >= focusableElements.length - 1 ? 0 : focusedIndex + 1;
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

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    const form = formRef.current;
    if (!form) return;

    const nameField = form.elements.namedItem("name") as HTMLInputElement;
    const typeField = form.elements.namedItem("type") as HTMLSelectElement;

    if (!nameField?.value.trim()) {
      setError("Column name is required");
      return;
    }

    if (!typeField?.value) {
      setError("Column type is required");
      return;
    }

    startTransition(async () => {
      const result = await createColumn(boardId, {
        name: nameField.value.trim(),
        type: typeField.value as ColumnType,
      });
      if (result.error) {
        setError(result.error);
      } else {
        onSuccess?.();
        onClose();
      }
    });
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 animate-fade-in"
      onClick={handleBackdropClick}
    >
      <div
        ref={contentRef}
        className="glass-elevated p-6 max-w-sm w-full mx-4 animate-slide-up"
      >
        <h2 className="text-lg font-semibold text-slate-800 mb-4">
          Add Column
        </h2>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
            {error}
          </div>
        )}

        <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="name"
              className="block text-sm font-medium text-slate-400 mb-1.5"
            >
              Column Name
            </label>
            <input
              ref={nameInputRef}
              id="name"
              name="name"
              type="text"
              required
              minLength={1}
              className="input-dark"
              placeholder="e.g., Priority, Sprint"
              disabled={isPending}
            />
          </div>

          <div>
            <label
              htmlFor="type"
              className="block text-sm font-medium text-slate-400 mb-1.5"
            >
              Column Type
            </label>
            <select
              id="type"
              name="type"
              required
              className="select-dark"
              disabled={isPending}
            >
              <option value="">Select a type...</option>
              {COLUMN_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.icon} {type.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="btn-ghost"
              disabled={isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={isPending}
            >
              {isPending ? "Creating..." : "Create Column"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
