import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

/** Create bill_payment records for every month from start_month to end_month. */
export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: { bill_id?: string; start_month?: string; end_month?: string };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { bill_id, start_month, end_month } = body;
  if (!bill_id || !start_month || !end_month) {
    return json({ error: 'bill_id, start_month, end_month required' }, 400);
  }

  const client = getClient(env);
  try {
    // Look up the bill defaults
    const cfg = await client.execute({
      sql: 'SELECT monthly_target, is_cc_default FROM budget_config WHERE id = ? LIMIT 1',
      args: [bill_id],
    });
    if (!cfg.rows.length) return json({ error: 'Bill not found' }, 404);

    const amount    = Number(cfg.rows[0].monthly_target ?? 0);
    const isCC      = Number(cfg.rows[0].is_cc_default ?? 0);

    // Generate all months in range
    const months: string[] = [];
    const [sy, sm] = start_month.split('-').map(Number);
    const [ey, em] = end_month.split('-').map(Number);
    let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
      months.push(`${y}-${String(m).padStart(2, '0')}`);
      m++; if (m > 12) { m = 1; y++; }
    }

    let created = 0;
    for (const month of months) {
      const id = `bp_${month}_${bill_id}`;
      await client.execute({
        sql: `INSERT INTO bill_payments (id, month, bill_id, amount, is_paid, is_cc, is_skipped)
              VALUES (?, ?, ?, ?, 0, ?, 0)
              ON CONFLICT(month, bill_id) DO UPDATE SET is_skipped = 0`,
        args: [id, month, bill_id, amount, isCC],
      });
      // Also ensure monthly_summary exists for this month
      await client.execute({
        sql: `INSERT OR IGNORE INTO monthly_summary (month) VALUES (?)`,
        args: [month],
      });
      created++;
    }

    return json({ ok: true, months_created: created });
  } finally { client.close(); }
}
