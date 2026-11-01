import { defineMiddleware } from 'astro:middleware';

// Pages carry no Cache-Control, so the home-screen web app may reuse a stale copy
// after a deploy. Make HTML always revalidate; leave routes that set their own alone.
export const onRequest = defineMiddleware(async (_context, next) => {
  const res = await next();
  if (res.headers.has('Cache-Control') || !res.headers.get('Content-Type')?.includes('text/html')) return res;
  try {
    res.headers.set('Cache-Control', 'no-cache');
    return res;
  } catch {
    // Proxied responses (e.g. /food) have immutable headers — copy them instead.
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'no-cache');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
});
