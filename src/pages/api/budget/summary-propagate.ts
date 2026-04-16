import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

const ALLOWED = new Set(['income_alex', 'income_maham', 'cc_budget']);

/**
 * POST { field, value, from_month }
 * Updates all monthly_summary rows where month > from_month with the given field/value.
 * Only propagates forward — past months are never touched.
 */
export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: { field?: string; value?: unknown; from_month?: string };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { field, value, from_month } = body;
  if (!field || !ALLOWED.has(field)) return json({ error: `field must be one of: ${[...ALLOWED].join(', ')}` }, 400);
  if (!from_month || !/^\d{4}-\d{2}$/.test(from_month)) return json({ error: 'Invalid from_month' }, 400);
  if (value === undefined || value === null) return json({ error: 'value required' }, 400);

  const client = getClient(env);
  try {
    const result = await client.execute({
      sql:  `UPDATE monthly_summary SET ${field} = ? WHERE month > ?`,
      args: [Number(value), from_month],
    });
    return json({ ok: true, rows_updated: result.rowsAffected });
  } finally { client.close(); }
}
