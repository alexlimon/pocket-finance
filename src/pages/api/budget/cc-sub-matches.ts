import type { APIRoute } from 'astro';
import { getClient, json } from '../../../lib/db';
import { verifySession } from '../../../lib/auth';
import { normalizeVendor } from '../../../lib/vendor-match';
import { prevMonth, statementWindow } from '../../../lib/budget';

export const GET: APIRoute = async ({ request, url, locals }) => {
  const env = (locals as any).runtime.env;
  if (!(await verifySession(request, env))) return json({ error: 'unauthorized' }, 401);

  const paymentMonth = url.searchParams.get('month');
  if (!paymentMonth || !/^\d{4}-\d{2}$/.test(paymentMonth)) return json({ error: 'bad month' }, 400);

  const client = getClient(env);
  try {
    const billsRes = await client.execute({
      sql: `SELECT bc.id, bc.name, bc.vendor_alias, bc.monthly_target,
                   COALESCE(bp.amount, bc.monthly_target) AS expected,
                   COALESCE(bp.is_paid, 0) AS is_paid
            FROM budget_config bc
            LEFT JOIN bill_payments bp ON bc.id = bp.bill_id AND bp.month = ?
            WHERE bc.is_recurring = 1 AND bc.is_cc_default = 1
            ORDER BY bc.due_day ASC`,
      args: [paymentMonth],
    });

    const settingsRes = await client.execute({ sql: 'SELECT billing_end_day FROM cc_settings LIMIT 1', args: [] });
    const billingEndDay = Number(settingsRes.rows[0]?.billing_end_day ?? 25);

    // All CC sub charges for paymentMonth fall within this single billing cycle window.
    const w = statementWindow(prevMonth(paymentMonth), billingEndDay);

    const txnsRes = await client.execute({
      sql: `SELECT date, description, amount
            FROM csv_transactions
            WHERE date >= ? AND date <= ?
              AND amount < 0
              AND (type IS NULL OR lower(type) != 'payment')`,
      args: [w.start, w.end],
    });
    const pool = txnsRes.rows.map(t => ({
      date:        String(t.date),
      description: String(t.description),
      normDesc:    normalizeVendor(String(t.description)),
      amount:      Math.abs(Number(t.amount)),
    }));

    const results = billsRes.rows.map((r: any) => {
      const id       = String(r.id);
      const alias    = r.vendor_alias ? String(r.vendor_alias).trim() : null;
      const expected = Number(r.expected ?? r.monthly_target ?? 0);
      const is_paid  = Number(r.is_paid) === 1;

      if (is_paid)  return { bill_id: id, matched: null, reason: 'already_paid' as const };
      if (!alias)   return { bill_id: id, matched: null, reason: 'no_alias' as const };

      // Find all transactions whose normalized description contains the alias
      const candidates = pool.filter(t => t.normDesc.includes(alias));
      if (!candidates.length) return { bill_id: id, matched: null, reason: 'no_match' as const };

      // Among candidates, pick the one closest to the expected amount
      const best = candidates.reduce((a, b) =>
        Math.abs(a.amount - expected) <= Math.abs(b.amount - expected) ? a : b
      );

      return {
        bill_id: id,
        matched: {
          date:        best.date,
          description: best.description,
          amount:      Number(best.amount.toFixed(2)),
        },
      };
    });

    return json({ month: paymentMonth, matches: results });
  } finally {
    client.close();
  }
};
