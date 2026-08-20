'use client';

import { EntityShareControls } from '../../components/sharing/EntityShareControls';

/**
 * Sharing for ONE board inside an org tree — a second, independent decision from
 * the tree's (design D12).
 *
 * A thin wrapper over `EntityShareControls`, which phase D generalized out of
 * this component when the roadmap and comparison surfaces needed the same
 * client-side fetch-and-open behaviour. Kept as a named component because the
 * call site reads better for it, and because the noun ("Board") is the one thing
 * that is genuinely specific here.
 */
export function EmployeeBoardShareControls({
  boardId,
  boardName,
}: {
  boardId: string;
  boardName: string;
}) {
  return (
    <EntityShareControls
      kind="employeeBoard"
      entityId={boardId}
      entityName={boardName}
      nounLabel="Board"
    />
  );
}
