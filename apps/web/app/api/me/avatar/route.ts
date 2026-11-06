import { MAX_AVATAR_BYTES } from '@deckgauge/shared';
import { getApiUrl, getAuthHeaders } from '../../../lib/api-server';

/**
 * Upload / remove the signed-in person's profile photo.
 *
 * A route handler rather than a server action: server actions cap the request
 * body at 1 MB by default, and a phone photo is routinely larger than that.
 */
export async function PUT(request: Request): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  // Multipart framing adds a little; anything far past the cap is refused here
  // rather than buffered.
  if (declared > MAX_AVATAR_BYTES + 64 * 1024) {
    return Response.json({ error: 'Photo is larger than 5 MB' }, { status: 413 });
  }

  const incoming = await request.formData();
  const file = incoming.get('file');
  if (!file || typeof file === 'string') {
    return Response.json({ error: 'No file provided' }, { status: 400 });
  }
  const blob =
    file instanceof Blob
      ? file
      : new Blob([await (file as unknown as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer()]);
  const forward = new FormData();
  forward.append('file', blob, (file as { name?: string }).name ?? 'photo');

  const res = await fetch(`${getApiUrl()}/me/avatar`, {
    method: 'PUT',
    headers: await getAuthHeaders(),
    body: forward,
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
  });
}

export async function DELETE(): Promise<Response> {
  const res = await fetch(`${getApiUrl()}/me/avatar`, {
    method: 'DELETE',
    headers: await getAuthHeaders(),
  });
  return new Response(null, { status: res.status });
}
