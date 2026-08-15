import type { AdvisorHistoryMessage, AdvisorPageContextDto } from '@deckgauge/shared';
import { authFetch } from '../../../../actions/api';

// Never statically cache/optimize this route — every response is a live SSE
// stream (or a passthrough error) tied to the caller's session.
export const dynamic = 'force-dynamic';

interface AdvisorHelpAskBody {
  question: string;
  pageContext: AdvisorPageContextDto;
  boardId?: string;
  // Same status as `boardId` above: the standalone Roadmap entity's id,
  // forwarded as its own top-level field (Task 1's shape) rather than folded
  // into `pageContext`, which stays exactly `{ key, label }`.
  roadmapId?: string;
  history?: AdvisorHistoryMessage[];
}

export async function POST(req: Request): Promise<Response> {
  const { question, pageContext, boardId, roadmapId, history } =
    (await req.json()) as AdvisorHelpAskBody;

  // The Fastify route needs the Keycloak JWT, which only ever lives
  // server-side (NextAuth session) — `authFetch` attaches it and hands back
  // the raw Response so the body stream pipes straight through.
  const apiRes = await authFetch('/advisor/help/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, pageContext, boardId, roadmapId, history }),
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
