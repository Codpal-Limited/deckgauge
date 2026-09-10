"use client";

import { useRef } from "react";
import { useOverlayDismiss } from "./useOverlayDismiss";

interface SlideOverPanelProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function SlideOverPanel({
  isOpen,
  onClose,
  title,
  children,
}: SlideOverPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape-to-close and the body scroll lock live in `useOverlayDismiss`, which
  // the mobile nav drawer shares. The lock is reference counted there, so this
  // panel no longer unlocks the page when it closes over a still-open drawer.
  useOverlayDismiss(isOpen, onClose);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/20 animate-fade-in"
        onClick={onClose}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        className="fixed right-0 top-0 z-50 h-full w-full max-w-md bg-white border-l border-slate-200 shadow-xl overflow-y-auto animate-slide-in-right"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-800">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-600 transition-colors"
            aria-label="Close panel"
          >
            {"\u2715"}
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </>
  );
}
