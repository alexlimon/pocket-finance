import type { APIRoute } from 'astro';
import { verifySession } from '../../lib/auth';
import { json } from '../../lib/db';
import { isPublicMealsAsset, proxyToMeals } from '../../lib/meals-proxy';

/** /food/* → pocket-meals, behind the household session. See src/lib/meals-proxy.ts. */
export const ALL: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const { pathname, search } = new URL(request.url);
  if (!isPublicMealsAsset(pathname) && !(await verifySession(request, env))) {
    if (pathname.startsWith('/food/api/')) return json({ error: 'Unauthorized' }, 401);
    // Remember the page so login can send them back (GET navigations only; a POST can't be replayed).
    const login = request.method === 'GET'
      ? `/login?next=${encodeURIComponent(pathname + search)}`
      : '/login';
    return new Response(null, { status: 302, headers: { Location: login } });
  }
  return proxyToMeals(request, env);
};
