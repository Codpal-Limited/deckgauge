'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useBodyScrollLock } from './useOverlayDismiss';
import { createPortal } from 'react-dom';

interface ImageLightboxProps {
  /** Image URL to display full-screen. */
  src: string;
  /** Alt text, mirrored from the source <img>. */
  alt?: string;
  /** Invoked when the viewer should close (backdrop, ✕, or Escape). */
  onClose: () => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.5;

/** Keep a zoom factor within the supported range. */
function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Monday.com-style image viewer: centers an image in a full-screen overlay
 * with zoom in/out/reset and drag-to-pan. Rendered through a portal on
 * document.body so an ancestor's transform/overflow (e.g. the slide-over
 * panel) cannot clip or mis-position it.
 */
export function ImageLightbox({ src, alt = '', onClose }: ImageLightboxProps) {
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  } | null>(null);

  const zoomIn = useCallback(() => setZoom((z) => clampZoom(z + ZOOM_STEP)), []);

  // Recentre the image whenever zoom returns to its minimum — a panned-then-
  // shrunk image would otherwise stay stuck off to one side.
  const zoomOut = useCallback(() => {
    setZoom((z) => {
      const next = clampZoom(z - ZOOM_STEP);
      if (next === MIN_ZOOM) setOffset({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') zoomIn();
      else if (e.key === '-' || e.key === '_') zoomOut();
      else if (e.key === '0') reset();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, zoomIn, zoomOut, reset]);

  // Prevent the page behind the overlay from scrolling while it's open.
  //
  // Reference counted with every other overlay, deliberately. A private
  // save/restore here was safe only under the tree shape that happens to exist
  // (this is always a descendant of a panel that already holds the lock). Review
  // demonstrated the general case: if the panel closed while this stayed
  // mounted, the page unlocked BENEATH an open lightbox, and this component's
  // own cleanup then restored `hidden` with no overlay open at all — a
  // permanently unscrollable page.
  useBodyScrollLock(true);

  const handleWheel = (e: React.WheelEvent) => {
    setZoom((z) => {
      const next = clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
      if (next === MIN_ZOOM) setOffset({ x: 0, y: 0 });
      return next;
    });
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (zoom <= MIN_ZOOM) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: offset.x,
      baseY: offset.y,
    };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset({
      x: drag.baseX + (e.clientX - drag.startX),
      y: drag.baseY + (e.clientY - drag.startY),
    });
  };

  const handlePointerUp = () => {
    dragRef.current = null;
  };

  if (typeof document === 'undefined') return null;

  const isPanning = dragRef.current !== null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Toolbar — stops propagation so its buttons don't trigger the backdrop close */}
      <div
        className="absolute top-4 right-4 flex items-center gap-1 rounded-lg bg-black/60 px-2 py-1 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={zoomOut}
          disabled={zoom <= MIN_ZOOM}
          aria-label="Zoom out"
          className="px-2 py-1 text-lg leading-none rounded hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {'−'}
        </button>
        <span className="w-12 text-center text-xs tabular-nums select-none">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={zoomIn}
          disabled={zoom >= MAX_ZOOM}
          aria-label="Zoom in"
          className="px-2 py-1 text-lg leading-none rounded hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          {'+'}
        </button>
        <button
          type="button"
          onClick={reset}
          aria-label="Reset zoom"
          className="px-2 py-1 text-sm leading-none rounded hover:bg-white/20"
        >
          {'↺'}
        </button>
        <div className="mx-1 h-5 w-px bg-white/30" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close image viewer"
          className="px-2 py-1 text-lg leading-none rounded hover:bg-white/20"
        >
          {'✕'}
        </button>
      </div>

      <img
        src={src}
        alt={alt}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          transition: isPanning ? 'none' : 'transform 0.15s ease-out',
          cursor: zoom > MIN_ZOOM ? (isPanning ? 'grabbing' : 'grab') : 'default',
          maxWidth: '90vw',
          maxHeight: '90vh',
        }}
        className="select-none object-contain"
      />
    </div>,
    document.body,
  );
}
