import { authFetch } from '../../../../../../actions/api';
import { passthrough } from '../../../../passthrough';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { boardId: string; sessionId: string } },
): Promise<Response> {
  return passthrough(
    await authFetch(`/boards/${params.boardId}/advisor/sessions/${params.sessionId}`),
  );
}

export async function DELETE(
  _req: Request,
  { params }: { params: { boardId: string; sessionId: string } },
): Promise<Response> {
  return passthrough(
    await authFetch(`/boards/${params.boardId}/advisor/sessions/${params.sessionId}`, {
      method: 'DELETE',
    }),
  );
}
