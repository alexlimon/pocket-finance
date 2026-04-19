import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { json } from '../../../lib/db';
import { getGmailStatus, clearTokens } from '../../../lib/gmail';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);
  return json(await getGmailStatus(env));
}

export async function DELETE(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);
  await clearTokens(env);
  return json({ ok: true });
}
