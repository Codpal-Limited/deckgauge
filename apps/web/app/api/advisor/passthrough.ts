/**
 * Mirrors the API's status and body back to the browser so the panel can act
 * on errors (404 session_not_found, 409 advisor_not_configured, 401/403)
 * rather than seeing a generic proxy failure.
 *
 * Shared by every advisor session proxy — each route file would otherwise
 * carry a byte-identical copy.
 */
export async function passthrough(apiRes: Response): Promise<Response> {
  // 204 has no body; `new Response(await apiRes.text(), {status: 204})` throws.
  if (apiRes.status === 204) return new Response(null, { status: 204 });
  return new Response(await apiRes.text(), {
    status: apiRes.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
