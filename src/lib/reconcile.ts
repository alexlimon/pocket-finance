/**
 * reconcile.ts — shared CC statement reconciliation.
 *
 * Publishes closed billing-month statement totals into the payment month's
 * cc_budget (respecting manual latches), then cascades one balance step
 * forward. Used by syncCCSpend (cron / Sync now) and by the cc-variable edit
 * endpoint so a manual correction reaches the payment month immediately.
 */
import type { Client } from '@libsql/client/web';
import { CC_BUDGET_LATCH_PREFIX } from './budget';
import { recomputeMonth } from './recompute';

export interface CardSettings {
  billing_end_day: number;
  payment_day: number;
}

export async function reconcileCCBudgets(
  client: Client,
  settingsMap: Map<string, CardSettings>,
): Promise<void> {
  const today = new Date();

  const spendRes = await client.execute({
    sql:  'SELECT month, card, amount FROM cc_variable_spend WHERE amount > 0',
    args: [],
  });
  const latchedRes = await client.execute({
    sql:  `SELECT key FROM settings WHERE key LIKE '${CC_BUDGET_LATCH_PREFIX}%' AND value = '1'`,
    args: [],
  });
  const latchedMonths = new Set(
    latchedRes.rows.map(r => String(r.key).slice(CC_BUDGET_LATCH_PREFIX.length))
  );

  // A billing month is final only once EVERY card carrying spend is past its own
  // cut-off. Cards close on different days (sapphire 18th, prime 23rd), so summing
  // whichever happened to close first would publish a single-card subtotal as the
  // whole month's statement total — and then silently revise it days later.
  const byBillingMonth = new Map<string, { total: number; allClosed: boolean }>();
  for (const r of spendRes.rows) {
    const card   = String(r.card);
    const bMonth = String(r.month);
    const s = settingsMap.get(card);
    if (!s) continue;
    const [y, m] = bMonth.split('-').map(Number);
    const closeDate = new Date(y, m - 1, s.billing_end_day);
    const entry = byBillingMonth.get(bMonth) ?? { total: 0, allClosed: true };
    entry.total += Number(r.amount) || 0;
    if (today < closeDate) entry.allClosed = false; // statement still open — not final yet
    byBillingMonth.set(bMonth, entry);
  }

  for (const [billingMonth, { total, allClosed }] of byBillingMonth) {
    if (!allClosed || total <= 0) continue;
    const [y, m] = billingMonth.split('-').map(Number);
    const payDate = new Date(y, m, 1); // m is 1-indexed → JS month=m wraps to next calendar month
    const paymentMonth = `${payDate.getFullYear()}-${String(payDate.getMonth() + 1).padStart(2, '0')}`;
    if (latchedMonths.has(paymentMonth)) continue; // user set this budget by hand

    await client.execute({
      sql:  `INSERT INTO monthly_summary (month, cc_budget) VALUES (?, ?) ON CONFLICT(month) DO NOTHING`,
      args: [paymentMonth, total],
    });
    await client.execute({
      sql:  `UPDATE monthly_summary SET cc_budget = ? WHERE month = ?`,
      args: [total, paymentMonth],
    });

    // The CC payment is a component of the payment month's NET — keep its chain current.
    await recomputeMonth(client, paymentMonth);
  }
}
