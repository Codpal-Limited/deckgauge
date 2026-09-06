/**
 * Resolves the `origin` option for `@fastify/cors`.
 *
 * The API previously registered `{ origin: true }` unconditionally, which
 * reflects whatever `Origin` header the caller sends. That is harmless on a
 * localhost-only deployment and wrong on a public one: any site could call the
 * API cross-origin and read the response.
 *
 * Browsers really do call this API cross-origin — `apps/web/next.config.mjs`
 * defines no rewrites, so `NEXT_PUBLIC_API_URL` points the browser straight at
 * the API — so CORS cannot simply be disabled. Hosted deployments set
 * `CORS_ALLOWED_ORIGINS` to an explicit list.
 *
 * Unset or blank keeps the previous reflect-any behaviour, so self-host
 * deployments are unaffected (spec §7).
 */
export function resolveCorsOrigin(
  env: Record<string, string | undefined>,
): true | string[] {
  const raw = env.CORS_ALLOWED_ORIGINS;

  // Unset, empty, or whitespace-only → previous behaviour.
  if (!raw || raw.trim() === "") return true;

  // A configured-but-unusable list (e.g. ",,,") deliberately yields an empty
  // array rather than `true`. Failing closed turns a typo into "no cross-origin
  // access" instead of "open to every site on the internet".
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
}
