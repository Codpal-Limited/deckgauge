import { authFetch } from '../../../../../../actions/api';
import { passthrough } from '../../../../passthrough';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  props: { params: Promise<{ boardId: string; sessionId: string }> }
): Promise<Response> {
  const params = await props.params;
  return passthrough(
    await authFetch(`/boards/${params.boardId}/advisor/sessions/${params.sessionId}`),
  );
}

export async function DELETE(
  _req: Request,
  props: { params: Promise<{ boardId: string; sessionId: string }> }
): Promise<Response> {
  const params = await props.params;
  return passthrough(
    await authFetch(`/boards/${params.boardId}/advisor/sessions/${params.sessionId}`, {
      method: 'DELETE',
    }),
  );
}
