/**
 * Reverse proxy for pocket-meals (separate repo + Pages project), served at /food/*.
 * pocket-finance owns auth: the route verifies the household session, then forwards here
 * with X-Meals-Auth. pocket-meals rejects anything without that shared secret.
 */

export type MealsEnv = Pick<CloudflareEnv, 'MEALS_ORIGIN' | 'MEALS_SHARED_SECRET'>;

/** Build assets are public in pocket-meals too — no session lookup needed for them. */
export function isPublicMealsAsset(pathname: string): boolean {
  return pathname.startsWith('/food/_astro/') || pathname === '/food/favicon.svg' || pathname === '/food/apple-touch-icon.png';
}

// Hop-by-hop and encoding headers that must not be copied across the proxy.
const DROP_REQ = ['host', 'cookie', 'authorization', 'content-length', 'x-meals-auth', 'connection'];
const DROP_RES = ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'];

export async function proxyToMeals(request: Request, env: MealsEnv): Promise<Response> {
  if (!env.MEALS_ORIGIN || !env.MEALS_SHARED_SECRET) {
    return new Response('Meals is not configured (MEALS_ORIGIN / MEALS_SHARED_SECRET).', { status: 503 });
  }
  const origin = env.MEALS_ORIGIN.replace(/\/$/, '');
  const src = new URL(request.url);
  const target = origin + src.pathname + src.search;

  const headers = new Headers(request.headers);
  for (const h of DROP_REQ) headers.delete(h);
  headers.set('X-Meals-Auth', env.MEALS_SHARED_SECRET);
  // Astro's CSRF check in pocket-meals compares Origin to its own host. This app's own check has
  // already verified the browser's Origin, so present the request as same-origin to pocket-meals.
  if (headers.has('origin')) headers.set('origin', origin);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let res: Response;
  try {
    res = await fetch(target, {
      method:   request.method,
      headers,
      body:     hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
    });
  } catch {
    return new Response('Meals is unavailable right now.', { status: 502 });
  }

  const out = new Headers(res.headers);
  for (const h of DROP_RES) out.delete(h);
  // Keep redirects on this origin even if pocket-meals ever emits absolute URLs.
  const loc = out.get('location');
  if (loc?.startsWith(origin)) out.set('location', loc.slice(origin.length) || '/food');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
