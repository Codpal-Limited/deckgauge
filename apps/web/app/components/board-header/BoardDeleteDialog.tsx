'use client';

interface BoardDeleteDialogProps {
  boardName: string;
  isPending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A modal rather than the inline confirmation row this replaces: the old row
 * expanded inside the action bar and shoved every control sideways mid-decision.
 */
export function BoardDeleteDialog({
  boardName,
  isPending,
  error,
  onConfirm,
  onCancel,
}: BoardDeleteDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 animate-fade-in">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Delete board"
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-surface-1 p-5 shadow-dropdown"
      >
        <h2 className="text-sm font-semibold text-slate-900">Delete “{boardName}”?</h2>
        <p className="mt-1.5 text-xs text-slate-500">
          Its groups and items are deleted with it. This cannot be undone.
        </p>
        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn-secondary px-3 py-1.5 text-xs">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
          >
            {isPending ? 'Deleting…' : 'Delete board'}
          </button>
        </div>
      </div>
    </div>
  );
}
