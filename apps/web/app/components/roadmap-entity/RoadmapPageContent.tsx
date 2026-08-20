'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RoadmapDetail } from '@deckgauge/shared';
import { RoadmapGrid } from './RoadmapGrid';
import RoadmapEntityCanvas from './RoadmapEntityCanvas';
import { RoadmapGroupPicker } from './RoadmapGroupPicker';
import { EntityShareControls } from '../sharing/EntityShareControls';

type ViewType = 'grid' | 'gantt';

interface RoadmapPageContentProps {
  roadmap: RoadmapDetail;
}

export default function RoadmapPageContent({ roadmap }: RoadmapPageContentProps) {
  const router = useRouter();
  // Gantt is the default view for a cross-board roadmap (timeline-first); the
  // Grid is opt-in via the toggle.
  const [activeView, setActiveView] = useState<ViewType>('gantt');
  const [pickerOpen, setPickerOpen] = useState(false);

  const hasGroups = roadmap.groups.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{roadmap.name}</h1>
        <div className="flex items-center gap-3">
          {/* The first sharing UI a roadmap has ever had (design §8). The
              per-group board re-check on every read stays exactly as it is
              (D16) — a roadmap viewer sees the groups whose boards they can
              read and no others. */}
          <EntityShareControls
            kind="roadmap"
            entityId={roadmap.id}
            entityName={roadmap.name}
            nounLabel="Roadmap"
          />
          <button
            onClick={() => setPickerOpen(true)}
            className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
          >
            + Add groups
          </button>
          <div className="flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 p-0.5">
            <button
              onClick={() => setActiveView('grid')}
              className={[
                'px-3 py-1 rounded text-sm font-medium transition-colors',
                activeView === 'grid'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              ].join(' ')}
              aria-pressed={activeView === 'grid'}
            >
              Grid
            </button>
            <button
              onClick={() => setActiveView('gantt')}
              className={[
                'px-3 py-1 rounded text-sm font-medium transition-colors',
                activeView === 'gantt'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              ].join(' ')}
              aria-pressed={activeView === 'gantt'}
            >
              Gantt
            </button>
          </div>
        </div>
      </div>

      {!hasGroups && (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-10 text-center">
          <p className="text-sm text-gray-500">
            This roadmap has no groups yet. Use <span className="font-medium">+ Add groups</span> to
            pull in groups from any board.
          </p>
        </div>
      )}

      {hasGroups && activeView === 'grid' && <RoadmapGrid roadmap={roadmap} />}

      {hasGroups && activeView === 'gantt' && <RoadmapEntityCanvas roadmap={roadmap} />}

      {pickerOpen && (
        <RoadmapGroupPicker
          roadmapId={roadmap.id}
          onClose={() => setPickerOpen(false)}
          onAdded={() => {
            setPickerOpen(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
