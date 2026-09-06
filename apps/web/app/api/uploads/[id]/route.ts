import { getApiUrl, getAuthHeaders } from '../../../lib/api-server';

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  const authHeaders = await getAuthHeaders();
  const res = await fetch(
    `${getApiUrl()}/api/uploads/${encodeURIComponent(params.id)}`,
    { headers: authHeaders },
  );

  if (!res.ok) {
    return new Response(null, { status: res.status });
  }

  return new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type': res.headers.get('content-type') ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
