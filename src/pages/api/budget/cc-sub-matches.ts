import type { APIRoute } from 'astro';
import { getClient, json } from '../../../lib/db';
import { verifySession } from '../../../lib/auth';
import { matchesAlias, pickSubCharge } from '../../../lib/vendor-match';
import { CHECKING_LAST4 } from '../../../lib/subscriptions';
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

    // Refunds stay in the pool so split-billed subs net out correctly. Checking is
    // excluded: its deposits would otherwise read as refunds against a CC alias.
    const txnsRes = await client.execute({
      sql: `SELECT date, description, amount
            FROM csv_transactions
            WHERE date >= ? AND date <= ?
              AND amount != 0
              AND account_last4 != ?
              AND (type IS NULL OR lower(type) != 'payment')`,
      args: [w.start, w.end, CHECKING_LAST4],
    });
    const pool = txnsRes.rows.map(t => ({
      date:        String(t.date),
      description: String(t.description),
      amount:      -Number(t.amount), // CSV: negative = charge → flip to Plaid convention
    }));

    const results = billsRes.rows.map((r: any) => {
      const id       = String(r.id);
      const alias    = r.vendor_alias ? String(r.vendor_alias).trim() : null;
      const target   = Number(r.monthly_target ?? 0);
      const is_paid  = Number(r.is_paid) === 1;

      if (is_paid)  return { bill_id: id, matched: null, reason: 'already_paid' as const };
      if (!alias)   return { bill_id: id, matched: null, reason: 'no_alias' as const };

      const candidates = pool.filter(t => matchesAlias(t.description, alias));
      if (!candidates.some(t => t.amount > 0)) return { bill_id: id, matched: null, reason: 'no_match' as const };

      const matched = pickSubCharge(candidates, target);
      if (!matched) return { bill_id: id, matched: null, reason: 'ambiguous' as const };
      return { bill_id: id, matched };
    });

    return json({ month: paymentMonth, matches: results });
  } finally {
    client.close();
  }
};
