import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

const VALID_ENTITIES   = new Set(['household', 'kirby', 'kennedy']);
const PATCHABLE_FIELDS = new Set(['category_id', 'entity_id', 'notes', 'is_hidden', 'merchant_clean']);

export async function PATCH(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const { id } = context.params;
  if (!id) return json({ error: 'Missing id' }, 400);

  let body: Record<string, unknown>;
  try {
    body = await context.request.json() as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const updates: string[] = [];
  const args:    unknown[] = [];

  for (const [key, val] of Object.entries(body)) {
    if (!PATCHABLE_FIELDS.has(key)) continue;
    if (key === 'entity_id' && !VALID_ENTITIES.has(String(val))) continue;
    updates.push(`${key} = ?`);
    args.push(val);
  }

  if (updates.length === 0) return json({ error: 'No valid fields to update' }, 400);

  updates.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`);
  args.push(id);

  const client = getClient(env);
  try {
    await client.execute({
      sql:  `UPDATE transactions SET ${updates.join(', ')} WHERE id = ?`,
      args,
    });
    return json({ ok: true });
  } finally {
    client.close();
  }
}
