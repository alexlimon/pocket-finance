import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

/**
 * POST { bill_id, amount, from_month }
 * - Updates budget_config.monthly_target (default for all new months)
 * - Updates all bill_payments.amount where bill_id = ? AND month > from_month
 */
export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: { bill_id?: string; amount?: unknown; from_month?: string };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { bill_id, amount, from_month } = body;
  if (!bill_id || amount === undefined || !from_month) return json({ error: 'bill_id, amount, from_month required' }, 400);
  if (!/^\d{4}-\d{2}$/.test(from_month)) return json({ error: 'Invalid from_month' }, 400);

  const amt = Number(amount);
  if (isNaN(amt)) return json({ error: 'Invalid amount' }, 400);

  const client = getClient(env);
  try {
    // Update the default target for all future months with no override
    await client.execute({
      sql:  'UPDATE budget_config SET monthly_target = ? WHERE id = ?',
      args: [amt, bill_id],
    });

    // Also update any existing bill_payments overrides in future months
    const result = await client.execute({
      sql:  'UPDATE bill_payments SET amount = ? WHERE bill_id = ? AND month > ?',
      args: [amt, bill_id, from_month],
    });

    return json({ ok: true, rows_updated: result.rowsAffected });
  } finally { client.close(); }
}
