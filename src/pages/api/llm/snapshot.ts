import type { APIContext } from 'astro';
import { verifyApiKey } from '../../../lib/auth';
import { json } from '../../../lib/db';
import { buildSnapshot } from '../../../lib/snapshot';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifyApiKey(context.request, env))) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const snapshot = await buildSnapshot(env);
  return json(snapshot);
}
