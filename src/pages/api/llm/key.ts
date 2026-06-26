import type { APIContext } from 'astro';
import { verifySession, setApiKey } from '../../../lib/auth';
import { json } from '../../../lib/db';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const key = await setApiKey(env);
  return json({ apiKey: key, note: 'Store now — not retrievable again.' });
}
