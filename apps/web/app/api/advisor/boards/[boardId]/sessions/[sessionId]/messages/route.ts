import { authFetch } from '../../../../../../../actions/api';
import { passthrough } from '../../../../../passthrough';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: { boardId: string; sessionId: string } },
): Promise<Response> {
  const body = await req.text();
  return passthrough(
    await authFetch(
      `/boards/${params.boardId}/advisor/sessions/${params.sessionId}/messages`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
    ),
  );
}
