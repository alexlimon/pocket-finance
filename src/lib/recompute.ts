/**
 * recompute.ts — server-side materialization of derived month fields.
 *
 * Every mutation endpoint calls recomputeMonth() / recomputeMonths() after its
 * writes so the stored chain (checking_after, next month's checking_before /
 * savings_before) stays current without any read-path (page-load) writes. The
 * derivation mirrors budget.astro: it runs the same pure functions over the same
 * stored inputs, so server truth and the client's DOM math can never diverge.
 *
 * Cost is two round-trips regardless of how many months are recomputed — one
 * batched read, one batched write. Month ranges can span years (propagating a
 * bill or an income change rewrites every later month), and a per-month query
 * loop would blow through Cloudflare's per-request subrequest budget.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { currentMonth, nextMonth, type MonthlySummary } from './budget';
import { resolveBillStatus, categorizeBills, computeCashFlow, computeBalances } from './budget-calc';

const BILL_COLS = `bc.*,
         bp.id             as payment_id,
         bp.amount         as paid_amount,
         COALESCE(bp.is_paid,    -1)                as explicit_paid,
         COALESCE(bp.is_cc,      bc.is_cc_default)  as is_cc,
         COALESCE(bp.is_skipped, 0)                 as is_skipped`;

/** Cap on statements per write batch, so a decade-long range stays a sane payload. */
const WRITE_CHUNK = 100;

/**
 * Recompute the derived balance chain for `months`.
 *
 * Months are processed in ascending order. When a month's immediate predecessor
 * is also in the set, its freshly computed end balance — not the stale stored
 * `checking_before` — seeds it, so a whole range settles in a single pass.
 */
export async function recomputeMonths(
  client: Client,
  months: string[],
  propagateSavings = false,
): Promise<void> {
  const targets = [...new Set(months)].sort();
  if (!targets.length) return;

  // Successors are fetched too: a month's checking_before is part of the chain,
  // and we only write it when the row already exists.
  const needed  = [...new Set([...targets, ...targets.map(nextMonth)])];
  const holes   = (n: number) => new Array(n).fill('?').join(',');

  const [sumRes, billRes, cashRes] = await client.batch([
    {
      sql:  `SELECT * FROM monthly_summary WHERE month IN (${holes(needed.length)})`,
      args: needed,
    },
    {
      // One cross join instead of a query per month: every (month, recurring bill)
      // pair, left-joined to that month's payment row.
      sql:  `WITH months(m) AS (VALUES ${targets.map(() => '(?)').join(',')})
             SELECT m.m AS chain_month, ${BILL_COLS}
             FROM months m
             CROSS JOIN budget_config bc
             LEFT JOIN bill_payments bp ON bc.id = bp.bill_id AND bp.month = m.m
             WHERE bc.is_recurring = 1
               AND (bc.start_month IS NULL OR bc.start_month <= m.m)
               AND (bc.end_month   IS NULL OR bc.end_month   >= m.m)`,
      args: targets,
    },
    {
      sql:  `SELECT month, type, amount FROM cash_expenses WHERE month IN (${holes(targets.length)})`,
      args: targets,
    },
  ]);

  const summaries = new Map<string, MonthlySummary & Record<string, unknown>>();
  for (const r of sumRes.rows) summaries.set(String(r.month), r as unknown as MonthlySummary & Record<string, unknown>);

  const billsByMonth = new Map<string, any[]>();
  for (const r of billRes.rows) {
    const m = String((r as any).chain_month);
    const list = billsByMonth.get(m);
    if (list) list.push(r); else billsByMonth.set(m, [r]);
  }

  const cashByMonth = new Map<string, { type: string; amount: number }[]>();
  for (const r of cashRes.rows) {
    const m = String(r.month);
    const e = { type: String(r.type), amount: Number(r.amount) || 0 };
    const list = cashByMonth.get(m);
    if (list) list.push(e); else cashByMonth.set(m, [e]);
  }

  const now      = currentMonth();
  const todayDay = new Date().getDate();
  const writes: InStatement[] = [];
  let carry: { month: string; checkingEnd: number } | null = null;

  for (const month of targets) {
    const stored = summaries.get(month);
    // No ledger row means nothing to derive from — skip it and break the chain
    // rather than seeding the next month off a phantom zero balance.
    if (!stored) { carry = null; continue; }

    const summary = carry && nextMonth(carry.month) === month
      ? { ...stored, checking_before: carry.checkingEnd }
      : stored;

    const resolved = resolveBillStatus(billsByMonth.get(month) ?? [], month === now, todayDay);
    const { checkingBills } = categorizeBills(resolved);

    const cf = computeCashFlow({
      summary,
      checkingBills,
      ccPaymentAmount: Number(summary.cc_budget) || 0,
      cashExpenses:    (cashByMonth.get(month) ?? []) as any,
    });
    const { checkingEnd } = computeBalances(summary, cf.netAmount);

    writes.push({
      sql:  'UPDATE monthly_summary SET checking_after = ? WHERE month = ?',
      args: [checkingEnd, month],
    });

    const next = nextMonth(month);
    if (summaries.has(next)) {
      writes.push({
        sql:  'UPDATE monthly_summary SET checking_before = ? WHERE month = ?',
        args: [checkingEnd, next],
      });
      if (propagateSavings) {
        writes.push({
          sql:  'UPDATE monthly_summary SET savings_before = ? WHERE month = ?',
          args: [Number(summary.savings_after) || 0, next],
        });
      }
    }

    carry = { month, checkingEnd };
  }

  for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
    await client.batch(writes.slice(i, i + WRITE_CHUNK));
  }
}

/** Recompute a single month's derived fields. */
export function recomputeMonth(client: Client, month: string, propagateSavings = false): Promise<void> {
  return recomputeMonths(client, [month], propagateSavings);
}
