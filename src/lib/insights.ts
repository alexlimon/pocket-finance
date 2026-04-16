/**
 * insights.ts — Macro-level financial aggregates for the home dashboard.
 *
 * Pure functions operating on already-fetched rows from the manual-entry budget
 * tables (monthly_summary, bill_payments × budget_config, cc_variable_spend,
 * cc_charges, cash_expenses). No DB access, no side effects.
 */

import type { MonthlySummary, CashExpense, CCCharge, BillRow } from './budget';

// ── Input row shapes (as fetched by index.astro) ─────────────────────────────

export interface VariableSpendRow {
  month:  string;
  card:   string;
  amount: number;
}

/** A bill_payments row joined with its budget_config. Minimal shape we need. */
export interface BillAggRow {
  month:          string;
  monthly_target: number | null;
  paid_amount:    number | null;
  is_paid:        number;
  is_cc_default:  number;
  is_skipped:     number;
}

export interface MonthAggregate {
  month:          string;
  inflowSalary:   number;
  inflowOther:    number;
  inflowTotal:    number;
  outflowFixed:   number;   // non-CC recurring bills (rent, utilities, insurance…)
  outflowSubs:    number;   // CC recurring subscriptions (media/software)
  outflowVariable:number;   // CC variable spend + big purchases + other cash expenses
  outflowTotal:   number;
  net:            number;
  anomaly:        boolean;  // outflow > inflow * 1.1
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function billAmount(r: BillAggRow): number {
  // Use paid amount if recorded, otherwise the monthly target.
  if (r.is_skipped) return 0;
  return Number(r.is_paid ? (r.paid_amount ?? r.monthly_target ?? 0) : (r.monthly_target ?? 0));
}

/** Aggregate one month's data into the macro bins used across widgets. */
export function aggregateMonth(params: {
  month:             string;
  summary:           MonthlySummary | null;
  bills:             BillAggRow[];
  variableSpend:     VariableSpendRow[];
  bigPurchases:      CCCharge[];
  cashExpenses:      CashExpense[];
}): MonthAggregate {
  const { month, summary, bills, variableSpend, bigPurchases, cashExpenses } = params;

  const inflowSalary = summary ? Number(summary.income_alex) + Number(summary.income_maham) : 0;
  const inflowOther  = cashExpenses.filter(e => e.type === 'income').reduce((s, e) => s + e.amount, 0);
  const inflowTotal  = inflowSalary + inflowOther;

  const outflowFixed = bills.filter(b => !b.is_cc_default).reduce((s, b) => s + billAmount(b), 0);
  const outflowSubs  = bills.filter(b =>  !!b.is_cc_default).reduce((s, b) => s + billAmount(b), 0);

  const variableCC = variableSpend.reduce((s, v) => s + v.amount, 0);
  const bigPurch   = bigPurchases.reduce((s, c) => s + c.amount, 0);
  const otherCash  = cashExpenses.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
  const outflowVariable = Math.max(0, variableCC - outflowSubs) + bigPurch + otherCash;

  const outflowTotal = outflowFixed + outflowSubs + outflowVariable;
  const net          = inflowTotal - outflowTotal;
  const anomaly      = inflowTotal > 0 && outflowTotal > inflowTotal * 1.1;

  return { month, inflowSalary, inflowOther, inflowTotal, outflowFixed, outflowSubs, outflowVariable, outflowTotal, net, anomaly };
}

// ── Safe to Spend (macro) ────────────────────────────────────────────────────

export type SafeToSpendState = 'healthy' | 'tight' | 'deficit';

export interface SafeToSpendResult {
  amount:       number;
  state:        SafeToSpendState;
  inflow:       number;
  fixed:        number;   // outflowFixed + outflowSubs
  savingsGoal:  number;
  ccMtd:        number;   // current month's variable CC + big purchases
}

/**
 * Safe_To_Spend = Total_Inflow − (Fixed_Outflow + Savings_Goal) − CC_Balance_MTD
 *
 * Savings_Goal is derived from monthly_summary (savings_after − savings_before).
 */
export function safeToSpend(params: {
  agg:          MonthAggregate;
  savingsGoal:  number;
  ccMtd:        number;
}): SafeToSpendResult {
  const { agg, savingsGoal, ccMtd } = params;
  const fixed  = agg.outflowFixed + agg.outflowSubs;
  const amount = agg.inflowTotal - (fixed + savingsGoal) - ccMtd;
  const state: SafeToSpendState =
    amount <= 0 ? 'deficit' : amount < 500 ? 'tight' : 'healthy';
  return { amount, state, inflow: agg.inflowTotal, fixed, savingsGoal, ccMtd };
}

// ── Structural Baseline Ratio ────────────────────────────────────────────────

export type BaselineBand = 'healthy' | 'moderate' | 'rigid';

export interface BaselineResult {
  ratio:     number;       // 0–1+ (e.g., 0.64 = 64% of income is structural)
  band:      BaselineBand;
  fixed:     number;
  subs:      number;
  inflow:    number;
}

export function baselineRatio(agg: MonthAggregate): BaselineResult {
  const structural = agg.outflowFixed + agg.outflowSubs;
  const ratio      = agg.inflowTotal > 0 ? structural / agg.inflowTotal : 0;
  const band: BaselineBand =
    ratio < 0.5 ? 'healthy' : ratio < 0.7 ? 'moderate' : 'rigid';
  return { ratio, band, fixed: agg.outflowFixed, subs: agg.outflowSubs, inflow: agg.inflowTotal };
}

// ── 12-Month Burn Line ───────────────────────────────────────────────────────

export interface BurnPoint {
  month:    string;        // 'YYYY-MM'
  label:    string;        // 'Jan'
  inflow:   number;
  outflow:  number;
  net:      number;
  anomaly:  boolean;
}

export function burnLine(aggregates: MonthAggregate[]): BurnPoint[] {
  return aggregates.map(a => {
    const [y, m] = a.month.split('-').map(Number);
    return {
      month:   a.month,
      label:   new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short' }),
      inflow:  a.inflowTotal,
      outflow: a.outflowTotal,
      net:     a.net,
      anomaly: a.anomaly,
    };
  });
}

// ── Sankey Payload ───────────────────────────────────────────────────────────

export interface SankeyNode { id: string; label: string; kind: 'source' | 'target' }
export interface SankeyLink { source: string; target: string; value: number }

export interface SankeyPayload {
  nodes: SankeyNode[];
  links: SankeyLink[];
  surplus: number;   // positive = surplus, negative = deficit (drawn on target side)
}

/**
 * Builds a Sankey payload for the current month.
 * Invariant: Sum(source outbound) === Sum(target inbound). If outflow > inflow,
 * the excess comes out of a synthetic "Reserves" source so the diagram balances.
 */
export function buildSankey(params: {
  agg:         MonthAggregate;
  savingsGoal: number;
}): SankeyPayload {
  const { agg, savingsGoal } = params;

  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];

  // Source nodes (only include non-zero flows so the diagram stays readable)
  if (agg.inflowSalary > 0) nodes.push({ id: 'src_salary', label: 'Salary',        kind: 'source' });
  if (agg.inflowOther  > 0) nodes.push({ id: 'src_other',  label: 'Other Income',  kind: 'source' });

  // Targets
  const surplus = agg.net - savingsGoal;
  if (agg.outflowFixed     > 0) nodes.push({ id: 'tgt_fixed',    label: 'Fixed',     kind: 'target' });
  if (agg.outflowSubs      > 0) nodes.push({ id: 'tgt_subs',     label: 'Subs',      kind: 'target' });
  if (agg.outflowVariable  > 0) nodes.push({ id: 'tgt_variable', label: 'Variable', kind: 'target' });
  if (savingsGoal          > 0) nodes.push({ id: 'tgt_savings',  label: 'Savings',   kind: 'target' });
  if (surplus              > 0) nodes.push({ id: 'tgt_surplus',  label: 'Surplus',   kind: 'target' });
  if (surplus              < 0) nodes.push({ id: 'tgt_deficit',  label: 'Deficit',   kind: 'target' });

  // Distribute each source proportionally across targets
  const totalOutflow = agg.outflowFixed + agg.outflowSubs + agg.outflowVariable
                     + Math.max(0, savingsGoal) + Math.max(0, surplus);
  const sources: { id: string; value: number }[] = [];
  if (agg.inflowSalary > 0) sources.push({ id: 'src_salary', value: agg.inflowSalary });
  if (agg.inflowOther  > 0) sources.push({ id: 'src_other',  value: agg.inflowOther  });

  // If there's a deficit, add a synthetic "Reserves" source so sums balance.
  if (surplus < 0) {
    nodes.unshift({ id: 'src_reserves', label: 'Reserves', kind: 'source' });
    sources.push({ id: 'src_reserves', value: -surplus });
  }

  const targets: { id: string; value: number }[] = [];
  if (agg.outflowFixed    > 0) targets.push({ id: 'tgt_fixed',    value: agg.outflowFixed });
  if (agg.outflowSubs     > 0) targets.push({ id: 'tgt_subs',     value: agg.outflowSubs });
  if (agg.outflowVariable > 0) targets.push({ id: 'tgt_variable', value: agg.outflowVariable });
  if (savingsGoal         > 0) targets.push({ id: 'tgt_savings',  value: savingsGoal });
  if (surplus             > 0) targets.push({ id: 'tgt_surplus',  value: surplus });

  const sourceTotal = sources.reduce((s, x) => s + x.value, 0);
  if (sourceTotal > 0 && totalOutflow > 0) {
    for (const src of sources) {
      for (const tgt of targets) {
        const value = (src.value / sourceTotal) * tgt.value;
        if (value > 0.01) links.push({ source: src.id, target: tgt.id, value });
      }
    }
  }

  return { nodes, links, surplus };
}

// ── Scenario Projector (pure, client-safe) ───────────────────────────────────

export type Scenario =
  | { kind: 'recurring_expense'; label: string; amount: number; startMonth: string }
  | { kind: 'one_time_purchase'; label: string; amount: number; month: string }
  | { kind: 'income_change';     label: string; deltaPct: number; startMonth: string };

/** Per-month baseline from actual budget data. */
export interface MonthBaseline {
  month:    string;   // 'YYYY-MM'
  income:   number;   // total inflow (salary + other cash income)
  expenses: number;   // total outflow (fixed + subs + variable)
  net:      number;   // income − expenses (pre-savings surplus)
}

export interface MonthProjection {
  month:           string;
  label:           string;
  baseIncome:      number;
  baseExpenses:    number;
  baseNet:         number;
  scenarioIncome:  number;
  scenarioExpenses:number;
  scenarioNet:     number;
  delta:           number;
  cumulativeDelta: number;
}

export interface ScenarioResult {
  projections:       MonthProjection[];
  totalDelta:        number;
  eoyBaseNet:        number;
  eoyScenarioNet:    number;
  needsReserves:     boolean;
  reservesDraw:      number;
  verdict:           'comfortable' | 'tight' | 'needs_reserves';
}

/**
 * Projects a what-if scenario using real per-month budget data.
 *
 * Each month in `monthBaselines` carries its own income/expenses/net from the
 * actual budget (monthly_summary + bill_payments + cc data). The scenario
 * overlays changes on top of each month's real figures.
 */
export function projectScenario(params: {
  scenario:       Scenario;
  monthBaselines: MonthBaseline[];
  currentSurplus: number;
}): ScenarioResult {
  const { scenario, monthBaselines, currentSurplus } = params;

  const projections: MonthProjection[] = [];
  let cumDelta = 0;
  let minCumDelta = 0;

  for (const mb of monthBaselines) {
    const [y, mo] = mb.month.split('-').map(Number);
    const label = new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'short' });

    let sIncome   = mb.income;
    let sExpenses = mb.expenses;

    if (scenario.kind === 'recurring_expense') {
      if (mb.month >= scenario.startMonth) sExpenses += scenario.amount;
    } else if (scenario.kind === 'one_time_purchase') {
      if (mb.month === scenario.month) sExpenses += scenario.amount;
    } else if (scenario.kind === 'income_change') {
      if (mb.month >= scenario.startMonth) {
        sIncome += mb.income * (scenario.deltaPct / 100);
      }
    }

    const sNet  = sIncome - sExpenses;
    const delta = sNet - mb.net;
    cumDelta   += delta;
    if (cumDelta < minCumDelta) minCumDelta = cumDelta;

    projections.push({
      month: mb.month, label,
      baseIncome: mb.income, baseExpenses: mb.expenses, baseNet: mb.net,
      scenarioIncome: sIncome, scenarioExpenses: sExpenses, scenarioNet: sNet,
      delta, cumulativeDelta: cumDelta,
    });
  }

  const eoyBaseNet     = projections.reduce((s, p) => s + p.baseNet, 0);
  const eoyScenarioNet = projections.reduce((s, p) => s + p.scenarioNet, 0);
  const totalDelta     = eoyScenarioNet - eoyBaseNet;

  const needsReserves = (currentSurplus + minCumDelta) < 0;
  const reservesDraw  = needsReserves ? Math.abs(currentSurplus + minCumDelta) : 0;

  const avgBaseNet = monthBaselines.length
    ? eoyBaseNet / monthBaselines.length
    : 0;
  const verdict: ScenarioResult['verdict'] =
    needsReserves ? 'needs_reserves'
    : totalDelta < -avgBaseNet ? 'tight'
    : 'comfortable';

  return { projections, totalDelta, eoyBaseNet, eoyScenarioNet, needsReserves, reservesDraw, verdict };
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function fmtCurrency(n: number, opts?: { compact?: boolean; sign?: boolean }): string {
  if (!isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style:                 'currency',
    currency:              'USD',
    notation:              opts?.compact ? 'compact' : 'standard',
    minimumFractionDigits: opts?.compact ? 0 : 0,
    maximumFractionDigits: opts?.compact ? 1 : 0,
    signDisplay:           opts?.sign ? 'always' : 'auto',
  }).format(n);
}

export function fmtPct(ratio: number): string {
  if (!isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}
