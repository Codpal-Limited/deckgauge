/** Extract a human-readable message from a non-ok API response. */
export async function readApiError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Body was not JSON — fall through to the raw text.
  }
  return text || `Request failed (${res.status})`;
}
