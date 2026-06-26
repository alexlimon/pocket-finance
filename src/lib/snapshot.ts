import { getClient, type Env } from './db';
import { aggregateMonth, type BillAggRow, type VariableSpendRow, type MonthAggregate } from './insights';
import type { MonthlySummary, CCCharge, CashExpense } from './budget';

type BillConfig = {
  id:             string;
  name:           string;
  monthly_target: number | null;
  is_cc_default:  number;
  start_month:    string | null;
  end_month:      string | null;
};

type BillPayRow = {
  month:      string;
  bill_id:    string;
  amount:     number;
  is_skipped: number;
};

export interface Snapshot {
  asOf:     string;
  currency: 'USD';
  balances: { checking: number; savings: number; totalLiquid: number };
  current: {
    month:   string;
    partial: boolean;
    income:  { alex: number; maham: number; other: number; total: number };
    outflow: { fixed: number; subs: number; variable: number; total: number };
    net:     number;
  };
  averages: {
    months:        number;
    monthlyIncome: number;
    monthlySpend:  number;
    monthlyNet:    number;
    savingsRate:   number;
  };
  trailing12:   Array<{ month: string; income: number; outflow: number; net: number }>;
  topRecurring: Array<{ name: string; amount: number; onCard: boolean }>;
}

const CC_PAYMENT_RE = /cc\s*payment|credit\s*card\s*payment/i;

function byMonth<T extends { month: string }>(rows: T[]): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) (out[r.month] ??= []).push(r);
  return out;
}

export async function buildSnapshot(env: Env): Promise<Snapshot> {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // 13 months oldest→newest; last element is currentMonth
  const months: string[] = Array.from({ length: 13 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (12 - i), 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const startMonth = months[0];

  const client = getClient(env);
  let summaries:   MonthlySummary[] = [];
  let billPayRows: BillPayRow[]     = [];
  let billConfigs: BillConfig[]     = [];
  let varSpend:    VariableSpendRow[]= [];
  let bigCharges:  CCCharge[]       = [];
  let cashRows:    CashExpense[]    = [];

  try {
    const [sumRes, billPayRes, configRes, varRes, ccRes, cashRes] = await Promise.all([
      client.execute({ sql: 'SELECT * FROM monthly_summary WHERE month >= ? ORDER BY month', args: [startMonth] }),
      client.execute({
        sql: `SELECT bp.month, bp.bill_id, bp.amount, COALESCE(bp.is_skipped, 0) as is_skipped
              FROM bill_payments bp
              JOIN budget_config bc ON bc.id = bp.bill_id
              WHERE bp.month >= ?`,
        args: [startMonth],
      }),
      client.execute({ sql: 'SELECT id, name, monthly_target, is_cc_default, start_month, end_month FROM budget_config WHERE is_recurring = 1', args: [] }),
      client.execute({ sql: 'SELECT month, card, amount FROM cc_variable_spend WHERE month >= ?', args: [startMonth] }),
      client.execute({ sql: 'SELECT * FROM cc_charges WHERE month >= ? AND is_big_purchase = 1', args: [startMonth] }),
      client.execute({ sql: 'SELECT * FROM cash_expenses WHERE month >= ?', args: [startMonth] }),
    ]);

    summaries   = sumRes.rows     as unknown as MonthlySummary[];
    billPayRows = billPayRes.rows as unknown as BillPayRow[];
    billConfigs = configRes.rows  as unknown as BillConfig[];
    varSpend    = varRes.rows     as unknown as VariableSpendRow[];
    bigCharges  = ccRes.rows      as unknown as CCCharge[];
    cashRows    = cashRes.rows    as unknown as CashExpense[];
  } finally {
    client.close();
  }

  // ── Lookups ──────────────────────────────────────────────────────────────────
  const sumMap = new Map(summaries.map(s => [s.month, s]));

  const billPayMap = new Map<string, { amount: number; is_skipped: boolean }>();
  for (const r of billPayRows) {
    billPayMap.set(`${r.month}|${r.bill_id}`, { amount: Number(r.amount), is_skipped: !!r.is_skipped });
  }

  const varByM  = byMonth(varSpend);
  const bigByM  = byMonth(bigCharges);
  const cashByM = byMonth(cashRows);

  // ── Bill resolution ──────────────────────────────────────────────────────────
  function billAggRowsForMonth(m: string): BillAggRow[] {
    const rows: BillAggRow[] = [];
    for (const bc of billConfigs) {
      if (CC_PAYMENT_RE.test(bc.name)) continue;
      if (bc.start_month && m < bc.start_month) continue;
      if (bc.end_month   && m > bc.end_month)   continue;
      if ((bc.monthly_target ?? 0) <= 0) continue;
      const pay = billPayMap.get(`${m}|${bc.id}`);
      if (pay?.is_skipped) continue;
      const amount = pay ? pay.amount : Number(bc.monthly_target ?? 0);
      rows.push({
        month:          m,
        monthly_target: amount,
        paid_amount:    amount,
        is_paid:        1,
        is_cc_default:  bc.is_cc_default,
        is_skipped:     0,
      });
    }
    return rows;
  }

  // ── Per-month aggregates ─────────────────────────────────────────────────────
  const aggregates: MonthAggregate[] = months.map(m => aggregateMonth({
    month:         m,
    summary:       sumMap.get(m) ?? null,
    bills:         billAggRowsForMonth(m),
    variableSpend: varByM[m] ?? [],
    bigPurchases:  bigByM[m] ?? [],
    cashExpenses:  cashByM[m] ?? [],
  }));

  // ── Balances ─────────────────────────────────────────────────────────────────
  const latestSummary = summaries.filter(s => s.month <= currentMonth).at(-1) ?? null;
  const checkingNow = latestSummary
    ? (Number(latestSummary.checking_after) || Number(latestSummary.checking_before) || 0)
    : 0;
  const savingsNow = latestSummary
    ? (Number(latestSummary.savings_after) || Number(latestSummary.savings_before) || 0)
    : 0;

  const currentSummary = sumMap.get(currentMonth) ?? null;
  const partial = !currentSummary || !Number(currentSummary.checking_after);

  // ── Current month income breakdown ───────────────────────────────────────────
  const currentAgg = aggregates[aggregates.length - 1];
  const incAlex    = Math.round(Number(currentSummary?.income_alex  ?? 0));
  const incMaham   = Math.round(Number(currentSummary?.income_maham ?? 0));
  const incOther   = Math.round(
    (cashByM[currentMonth] ?? [])
      .filter(e => e.type === 'income')
      .reduce((s, e) => s + Number(e.amount), 0)
  );

  // ── Averages (trailing 12 completed months) ──────────────────────────────────
  const completed = aggregates.filter(a => a.month < currentMonth);
  const n = completed.length || 1;
  const avg = (sel: (a: MonthAggregate) => number) =>
    Math.round(completed.reduce((s, a) => s + sel(a), 0) / n);

  const monthlyIncome = avg(a => a.inflowTotal);
  const monthlySpend  = avg(a => a.outflowTotal);
  const monthlyNet    = avg(a => a.net);
  const savingsRate   = monthlyIncome > 0 ? +(monthlyNet / monthlyIncome).toFixed(3) : 0;

  // ── Top recurring bills (active in current month, by size) ───────────────────
  const topRecurring = billConfigs
    .filter(bc => {
      if (CC_PAYMENT_RE.test(bc.name)) return false;
      if (bc.start_month && currentMonth < bc.start_month) return false;
      if (bc.end_month   && currentMonth > bc.end_month)   return false;
      return (bc.monthly_target ?? 0) > 0;
    })
    .sort((a, b) => Number(b.monthly_target ?? 0) - Number(a.monthly_target ?? 0))
    .slice(0, 8)
    .map(bc => ({
      name:   bc.name,
      amount: Math.round(Number(bc.monthly_target ?? 0)),
      onCard: !!bc.is_cc_default,
    }));

  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  return {
    asOf:     today,
    currency: 'USD',
    balances: {
      checking:    Math.round(checkingNow),
      savings:     Math.round(savingsNow),
      totalLiquid: Math.round(checkingNow + savingsNow),
    },
    current: {
      month:   currentMonth,
      partial,
      income:  { alex: incAlex, maham: incMaham, other: incOther, total: Math.round(currentAgg.inflowTotal) },
      outflow: {
        fixed:    Math.round(currentAgg.outflowFixed),
        subs:     Math.round(currentAgg.outflowSubs),
        variable: Math.round(currentAgg.outflowVariable),
        total:    Math.round(currentAgg.outflowTotal),
      },
      net: Math.round(currentAgg.net),
    },
    averages: {
      months:        completed.length,
      monthlyIncome,
      monthlySpend,
      monthlyNet,
      savingsRate,
    },
    trailing12: completed.map(a => ({
      month:   a.month,
      income:  Math.round(a.inflowTotal),
      outflow: Math.round(a.outflowTotal),
      net:     Math.round(a.net),
    })),
    topRecurring,
  };
}
