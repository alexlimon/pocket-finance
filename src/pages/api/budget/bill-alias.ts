import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

// GET — returns all CC recurring bills with their current vendor_alias
export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const client = getClient(env);
  try {
    const r = await client.execute(
      `SELECT id, name, vendor_alias
       FROM budget_config
       WHERE is_recurring = 1 AND is_cc_default = 1
       ORDER BY name ASC`
    );
    return json(r.rows);
  } finally { client.close(); }
}

// POST { bill_id, vendor_alias } — set or clear the alias on one bill.
// Atomically clears any other bill that had the same alias first (1:1 mapping).
export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: { bill_id?: string; vendor_alias?: string | null };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { bill_id, vendor_alias } = body;
  if (!bill_id) return json({ error: 'bill_id required' }, 400);

  const alias = vendor_alias?.trim() || null;

  const client = getClient(env);
  try {
    if (alias) {
      // Clear any other bill that already owns this alias (keeps mapping 1:1)
      await client.execute({
        sql:  `UPDATE budget_config SET vendor_alias = NULL WHERE vendor_alias = ? AND id != ?`,
        args: [alias, bill_id],
      });
    }
    await client.execute({
      sql:  `UPDATE budget_config SET vendor_alias = ? WHERE id = ?`,
      args: [alias, bill_id],
    });
    return json({ ok: true });
  } finally { client.close(); }
}
