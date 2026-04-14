import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: { month?: string; bill_id?: string; amount?: number; is_paid?: boolean; is_cc?: boolean };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { month, bill_id, amount, is_paid, is_cc } = body;
  if (!month || !bill_id) return json({ error: 'month and bill_id required' }, 400);

  const id = `bp_${month}_${bill_id}`;
  const client = getClient(env);
  try {
    if (amount !== undefined) {
      // Full upsert with all fields
      await client.execute({
        sql: `INSERT INTO bill_payments (id, month, bill_id, amount, is_paid, is_cc)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(month, bill_id) DO UPDATE SET
                amount  = excluded.amount,
                is_paid = excluded.is_paid,
                is_cc   = excluded.is_cc`,
        args: [id, month, bill_id, amount, is_paid ? 1 : 0, is_cc ? 1 : 0],
      });
    } else {
      // Toggle paid status only — upsert preserving existing amount
      const existing = await client.execute({
        sql: 'SELECT * FROM bill_payments WHERE month = ? AND bill_id = ? LIMIT 1',
        args: [month, bill_id],
      });
      if (existing.rows.length) {
        await client.execute({
          sql:  'UPDATE bill_payments SET is_paid = ? WHERE month = ? AND bill_id = ?',
          args: [is_paid ? 1 : 0, month, bill_id],
        });
      } else {
        // Get default amount from budget_config
        const cfg = await client.execute({
          sql: 'SELECT monthly_target, is_cc_default FROM budget_config WHERE id = ? LIMIT 1',
          args: [bill_id],
        });
        const defaultAmt = cfg.rows.length ? Number(cfg.rows[0].monthly_target ?? 0) : 0;
        const defaultCC  = cfg.rows.length ? Number(cfg.rows[0].is_cc_default ?? 0) : 0;
        await client.execute({
          sql: `INSERT INTO bill_payments (id, month, bill_id, amount, is_paid, is_cc)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [id, month, bill_id, defaultAmt, is_paid ? 1 : 0, defaultCC],
        });
      }
    }
    return json({ ok: true });
  } finally { client.close(); }
}
