import { getApiUrl, getAuthHeaders } from '../../../lib/api-server';

/** Auth proxy for a person's profile photo. The API decides who may see it. */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  const authHeaders = await getAuthHeaders();
  const res = await fetch(`${getApiUrl()}/api/user-avatars/${encodeURIComponent(params.id)}`, {
    headers: authHeaders,
  });
  if (!res.ok) return new Response(null, { status: res.status });

  return new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type': res.headers.get('content-type') ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      // The URL names one upload, and a new photo is a new upload — so a
      // long private cache is safe.
      'Cache-Control': 'private, max-age=86400',
    },
  });
}
