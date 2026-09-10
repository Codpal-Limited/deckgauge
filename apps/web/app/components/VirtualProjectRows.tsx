'use client';

import { FixedSizeList, type ListChildComponentProps } from 'react-window';
import type { Project } from '@deckgauge/shared';
import { ProjectRow, type ProjectRowProps } from './ProjectRow';

// Fixed row height in px. Matches the rendered BoardRow height; tune if the row
// design changes. Rows use `truncate`, so a fixed height is safe.
//
// STALE ON MOBILE as of the 44px touch-target work, and deliberately NOT fixed
// by changing this number. `BoardRow`'s delete-confirm branch is 65px below
// `md` (two 44px buttons in a row) against this 44px slot, so in a group over
// `VIRTUALIZE_THRESHOLD` the bottom ~21px of a confirm row is covered by the
// following slot and the bottom ~10px of both Cancel and Delete is not
// clickable. Pre-branch it was a 30px button sitting entirely inside the slot —
// 30px effective against 34px now — so the touch-target work improved this and
// fell short rather than regressing it.
//
// Raising ROW_HEIGHT would make every normal row taller to accommodate a
// transient state, which is the wrong trade. The fix is a variable-size list or
// taking the confirm row out of the virtualised flow.
//
// Worth knowing why no test caught it: `measureMobileSanity` reads
// `getBoundingClientRect`, which reports both buttons as a clean 44px while
// 10px of each is dead. Only `elementFromPoint` sees it — the same thing that
// caught the invisible tab-menu tap thief. A rect is not a hit test.
export const ROW_HEIGHT = 44;
// Cap the in-group scroll viewport so a 20K group scrolls inside its own window
// instead of emitting 20K DOM nodes.
export const MAX_VIEWPORT_PX = 640;

type ProjectWithFields = Project & { fieldValues?: Record<string, string> };

interface VirtualProjectRowsProps {
  projects: ProjectWithFields[];
  buildRowProps: (project: ProjectWithFields) => ProjectRowProps;
}

interface RowData {
  projects: ProjectWithFields[];
  buildRowProps: (project: ProjectWithFields) => ProjectRowProps;
}

function Row({ index, style, data }: ListChildComponentProps<RowData>) {
  const project = data.projects[index];
  return (
    <div style={style}>
      <ProjectRow {...data.buildRowProps(project)} />
    </div>
  );
}

export function VirtualProjectRows({ projects, buildRowProps }: VirtualProjectRowsProps) {
  const height = Math.min(projects.length * ROW_HEIGHT, MAX_VIEWPORT_PX);
  return (
    <FixedSizeList
      height={height}
      width="100%"
      itemCount={projects.length}
      itemSize={ROW_HEIGHT}
      itemKey={(index) => projects[index].id}
      itemData={{ projects, buildRowProps }}
      overscanCount={6}
    >
      {Row}
    </FixedSizeList>
  );
}
