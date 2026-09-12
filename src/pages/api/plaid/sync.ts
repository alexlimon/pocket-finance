import type { APIContext } from 'astro';
import { verifySession, verifyApiKey } from '../../../lib/auth';
import { json } from '../../../lib/db';
import { syncCCSpend } from '../../../lib/plaid-sync';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  const authed = (await verifySession(context.request, env)) || (await verifyApiKey(context.request, env));
  if (!authed) return json({ error: 'Unauthorized' }, 401);
  await syncCCSpend(env);
  return json({ ok: true });
}
