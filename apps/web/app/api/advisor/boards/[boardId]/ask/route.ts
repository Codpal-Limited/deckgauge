import type { AdvisorHistoryMessage, AdvisorPageContextDto } from '@deckgauge/shared';
import { authFetch } from '../../../../../actions/api';

// Never statically cache/optimize this route — every response is a live
// SSE stream (or a passthrough error) tied to the caller's session.
export const dynamic = 'force-dynamic';

interface AdvisorAskBody {
  question: string;
  widgetType?: string;
  /**
   * Prior turns. Previously declared-away here, which silently dropped it —
   * the API accepts and replays it, so every follow-up on the HTTP path was
   * arriving with no conversation behind it.
   */
  history?: AdvisorHistoryMessage[];
  pageContext?: AdvisorPageContextDto;
}

export async function POST(req: Request, props: { params: Promise<{ boardId: string }> }): Promise<Response> {
  const params = await props.params;
  const { boardId } = params;
  const { question, widgetType, history, pageContext } = (await req.json()) as AdvisorAskBody;

  // The Fastify `/boards/:boardId/advisor/ask` endpoint requires the
  // Keycloak JWT, which only ever lives server-side (NextAuth session) in
  // this app — the browser never holds it. `authFetch` runs server-side,
  // attaches the auth header, and hands back the raw `Response` so its
  // body stream can be piped straight through without buffering.
  const apiRes = await authFetch(`/boards/${boardId}/advisor/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boardId, question, widgetType, history, pageContext }),
  });

  if (!apiRes.ok) {
    // Pass the API's error body (e.g. 409 advisor_not_configured, 400, 401/403)
    // straight through so the panel can show it.
    return new Response(await apiRes.text(), {
      status: apiRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Stream the SSE body through as-is — do not buffer, or the panel loses
  // the token-by-token deltas.
  return new Response(apiRes.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
