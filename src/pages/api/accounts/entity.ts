import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

const VALID_ENTITIES = new Set(['household', 'kirby', 'kennedy']);

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let accountId: string, entityId: string;
  try {
    const body = await context.request.json() as { accountId?: string; entityId?: string };
    accountId  = String(body.accountId ?? '').trim();
    entityId   = String(body.entityId  ?? '').trim();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!accountId)                      return json({ error: 'Missing accountId' }, 400);
  if (!VALID_ENTITIES.has(entityId))   return json({ error: 'Invalid entityId' }, 400);

  const client = getClient(env);
  try {
    await client.execute({
      sql:  `UPDATE accounts SET entity_id = ? WHERE id = ?`,
      args: [entityId, accountId],
    });
    return json({ ok: true });
  } finally {
    client.close();
  }
}
