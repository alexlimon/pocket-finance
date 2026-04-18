import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { json } from '../../../lib/db';
import { syncCCSpend } from '../../../lib/plaid-sync';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);
  await syncCCSpend(env);
  return json({ ok: true });
}
