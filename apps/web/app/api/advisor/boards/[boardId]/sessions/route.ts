import { authFetch } from '../../../../../actions/api';
import { passthrough } from '../../../passthrough';

// The Keycloak JWT only ever lives server-side (NextAuth session) in this app,
// so every advisor call is proxied through `authFetch` rather than hit from the
// browser. Never cache: session lists are per-user and change constantly.
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { boardId: string } },
): Promise<Response> {
  return passthrough(await authFetch(`/boards/${params.boardId}/advisor/sessions`));
}

export async function POST(
  _req: Request,
  { params }: { params: { boardId: string } },
): Promise<Response> {
  return passthrough(
    await authFetch(`/boards/${params.boardId}/advisor/sessions`, { method: 'POST' }),
  );
}
