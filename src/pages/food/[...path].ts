import type { APIRoute } from 'astro';
import { verifySession } from '../../lib/auth';
import { json } from '../../lib/db';
import { isPublicMealsAsset, proxyToMeals } from '../../lib/meals-proxy';

/** /food/* → pocket-meals, behind the household session. See src/lib/meals-proxy.ts. */
export const ALL: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const { pathname } = new URL(request.url);
  if (!isPublicMealsAsset(pathname) && !(await verifySession(request, env))) {
    return pathname.startsWith('/food/api/')
      ? json({ error: 'Unauthorized' }, 401)
      : new Response(null, { status: 302, headers: { Location: '/login' } });
  }
  return proxyToMeals(request, env);
};
