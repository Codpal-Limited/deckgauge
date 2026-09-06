import { RoadmapCanvas } from '../../../components/roadmap/RoadmapCanvas';
import {
  loadRoadmapView,
  loadBoardColumns,
  getBoardRole,
} from '../../../actions/roadmap';

export const dynamic = 'force-dynamic';

interface RoadmapPageProps {
  params: Promise<{ boardId: string }>;
  searchParams: Promise<{ viewId?: string }>;
}

export default async function RoadmapPage(props: RoadmapPageProps) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const { boardId } = params;

  const [role, initial, columns] = await Promise.all([
    getBoardRole(boardId),
    loadRoadmapView(boardId, searchParams.viewId),
    loadBoardColumns(boardId),
  ]);

  const canEdit = role === 'EDITOR' || role === 'OWNER';

  return (
    <RoadmapCanvas
      boardId={boardId}
      viewId={initial.config.boardViewId}
      initial={initial}
      columns={columns}
      canEdit={canEdit}
    />
  );
}
