import { BoardUnifiedTabsHost } from '../../components/tabs/BoardUnifiedTabsHost';

export default async function BoardSubLayout(
  props: {
    children: React.ReactNode;
    params: Promise<{ boardId: string }>;
  }
) {
  const params = await props.params;

  const {
    children
  } = props;

  return (
    <>
      <BoardUnifiedTabsHost boardId={params.boardId} />
      {children}
    </>
  );
}
