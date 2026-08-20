'use client';

interface BoardDescriptionPopoverProps {
  value: string;
  description: string | null;
  /** Editing is board(EDITOR)+ — the same tier as rename (PATCH /boards/:id). */
  canEdit: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onCommit: () => void;
  onClose: () => void;
}

const MAX_LENGTH = 500;

export function BoardDescriptionPopover({
  value,
  description,
  canEdit,
  error,
  onChange,
  onCommit,
  onClose,
}: BoardDescriptionPopoverProps) {
  return (
    <div className="absolute left-0 top-full z-40 mt-2 w-80 rounded-xl border border-slate-200 bg-surface-1 p-4 shadow-dropdown animate-slide-up">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Description
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close description"
          className="text-slate-400 transition-colors hover:text-slate-600"
        >
          ✕
        </button>
      </div>

      {canEdit ? (
        <>
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onCommit}
            placeholder="Add a board description (up to 500 characters)..."
            maxLength={MAX_LENGTH}
            rows={3}
            className="input-dark resize-none"
          />
          <p className="mt-1.5 text-xs text-slate-500">
            {value.length}/{MAX_LENGTH}
          </p>
          {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
        </>
      ) : (
        <p className="whitespace-pre-wrap text-sm text-slate-600">
          {description || 'No description.'}
        </p>
      )}
    </div>
  );
}
