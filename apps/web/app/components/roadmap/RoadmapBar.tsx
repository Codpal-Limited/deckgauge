'use client';
import { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { PX_PER_DAY, BAR_HEIGHT, BAR_GAP, dateToX, daysBetween, xToDate, snapToDay } from './geometry';

interface RoadmapBarProps {
  id: string;
  title: string;
  startDate: Date;
  endDate: Date;
  color: string;
  isUnsized: boolean;
  isPinned: boolean;
  viewStart: Date;
  readOnly: boolean;
  /** group the bar currently belongs to — carried as drag data */
  groupId: string | null;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onResize?: (id: string, endDate: Date) => void;
  onResizePreview?: (x: number | null, date: Date | null) => void;
}

const STRIPE = 'repeating-linear-gradient(45deg, rgba(255,255,255,0.22) 0 7px, transparent 7px 14px)';

export function RoadmapBar(props: RoadmapBarProps) {
  const { id, title, startDate, endDate, color, isUnsized, isPinned, viewStart, readOnly, groupId } =
    props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [resizeWidth, setResizeWidth] = useState<number | null>(null);

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    disabled: readOnly || editing,
    data: { groupId },
  });

  const left = dateToX(startDate, viewStart);
  const width = Math.max(daysBetween(startDate, endDate) * PX_PER_DAY - BAR_GAP, 26);

  const onGripPointerDown = (e: React.PointerEvent) => {
    if (readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const baseWidth = width;

    const move = (ev: PointerEvent) => {
      const next = Math.max(PX_PER_DAY, baseWidth + (ev.clientX - startX));
      setResizeWidth(next);
      const edgeDate = snapToDay(xToDate(left + next + BAR_GAP, viewStart));
      props.onResizePreview?.(left + next + BAR_GAP, edgeDate);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const finalWidth = Math.max(PX_PER_DAY, baseWidth + (ev.clientX - startX));
      const endDate = snapToDay(xToDate(left + finalWidth + BAR_GAP, viewStart));
      setResizeWidth(null);
      props.onResizePreview?.(null, null);
      props.onResize?.(id, endDate);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const ariaLabel = `${title}, ${fmt(startDate)} to ${fmt(endDate)}${
    isUnsized ? ', unsized' : ''
  }${isPinned ? ', pinned' : ''}`;

  return (
    <div
      ref={setNodeRef}
      aria-label={ariaLabel}
      title={`${title} · ${fmt(startDate)} – ${fmt(endDate)}${isUnsized ? ' · unsized' : ''}`}
      data-unsized={isUnsized}
      data-pinned={isPinned}
      className="group/bar transition-[transform,box-shadow] duration-150 hover:-translate-y-px hover:shadow-lg hover:z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-slate-400"
      // listeners spread on the container, but the PointerSensor distance
      // constraint (set in DndContext) prevents a plain click from activating.
      {...attributes}
      {...listeners}
      // After the spreads on purpose: dnd-kit's `attributes` also carries
      // role/tabIndex, so declaring them above meant the spread silently
      // overwrote them (same values, so behaviour is unchanged — but React 19's
      // stricter JSX checking reports the shadowing as TS2783).
      role="button"
      tabIndex={0}
      onClick={() => !editing && props.onOpen(id)}
      style={{
        position: 'absolute',
        top: '50%',
        transform: 'translateY(-50%)',
        left: `${left}px`,
        width: `${resizeWidth ?? width}px`,
        height: BAR_HEIGHT,
        backgroundColor: color,
        backgroundImage: isUnsized ? STRIPE : undefined,
        opacity: isDragging ? 0.5 : 1,
        borderRadius: 9999,
        boxShadow: isPinned
          ? 'inset 3px 0 0 rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.25), 0 1px 2px rgba(15,23,42,0.18)'
          : 'inset 0 1px 0 rgba(255,255,255,0.25), 0 1px 2px rgba(15,23,42,0.18)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0.1,
        textShadow: '0 1px 1px rgba(0,0,0,0.28)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        cursor: readOnly ? 'pointer' : 'grab',
        touchAction: 'none',
      }}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft !== title) props.onRename(id, draft);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            // Prevent DndContext keyboard sensor from hijacking input keys
            e.stopPropagation();
          }}
          // Prevent dnd listeners from capturing pointer events on the input
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            width: '100%',
            background: 'transparent',
            color: '#fff',
            border: 'none',
            outline: 'none',
            font: 'inherit',
          }}
        />
      ) : (
        <span
          onDoubleClick={() => !readOnly && setEditing(true)}
          style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {title}
        </span>
      )}
      {!readOnly && (
        <span
          data-testid="resize-grip-right"
          onPointerDown={onGripPointerDown}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            right: 0,
            top: 0,
            bottom: 0,
            width: 10,
            cursor: 'ew-resize',
            touchAction: 'none',
          }}
        />
      )}
    </div>
  );
}
