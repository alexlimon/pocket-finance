/**
 * insights.ts — Macro-level financial aggregates for the home dashboard.
 *
 * Pure functions operating on already-fetched rows from the manual-entry budget
 * tables (monthly_summary, bill_payments × budget_config, cc_variable_spend,
 * cc_charges, cash_expenses) and uploaded card CSVs (csv_transactions).
 * No DB access, no side effects.
 */

import { openCycleMonth, statementWindow, type MonthlySummary, type CashExpense, type CCCharge, type BillRow } from './budget';

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
  | { kind: 'recurring_expense'; label: string; amount: number; startMonth: string; isIncome?: boolean }
  | { kind: 'one_time_purchase'; label: string; amount: number; month: string }
  | { kind: 'income_change';     label: string; deltaPct: number; startMonth: string };

/** Per-month baseline from actual budget data. */
export interface MonthBaseline {
  month:         string;   // 'YYYY-MM'
  income:        number;   // total inflow (salary + other cash income)
  expenses:      number;   // total outflow (fixed + subs + variable)
  net:           number;   // income − expenses (pre-savings surplus)
  incomeAlex?:   number;
  incomeMaham?:  number;
  checkingBills?: number;
  ccPayment?:    number;
  cashOut?:      number;
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
  scenarios:      Scenario[];
  monthBaselines: MonthBaseline[];
}): ScenarioResult {
  const { scenarios, monthBaselines } = params;

  const projections: MonthProjection[] = [];
  let cumDelta = 0;

  for (const mb of monthBaselines) {
    const [y, mo] = mb.month.split('-').map(Number);
    const label = new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'short' });

    let sIncome   = mb.income;
    let sExpenses = mb.expenses;

    for (const scenario of scenarios) {
      if (scenario.kind === 'recurring_expense') {
        if (mb.month >= scenario.startMonth) {
          if (scenario.isIncome) sIncome += scenario.amount;
          else sExpenses += scenario.amount;
        }
      } else if (scenario.kind === 'one_time_purchase') {
        if (mb.month === scenario.month) sExpenses += scenario.amount;
      } else if (scenario.kind === 'income_change') {
        if (mb.month >= scenario.startMonth) {
          sIncome += mb.income * (scenario.deltaPct / 100);
        }
      }
    }

    const sNet  = sIncome - sExpenses;
    const delta = sNet - mb.net;
    cumDelta   += delta;


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

  // Affordability is judged on the year's total net, not month-by-month.
  // If the year still ends positive after the new expense, you just save less —
  // no reserves needed. Only when the full-year net goes negative do you need
  // to draw from savings.
  const needsReserves = eoyScenarioNet < 0;
  const reservesDraw  = needsReserves ? Math.abs(eoyScenarioNet) : 0;

  const verdict: ScenarioResult['verdict'] =
    needsReserves ? 'needs_reserves'
    : totalDelta < -(eoyBaseNet / (monthBaselines.length || 1)) ? 'tight'
    : 'comfortable';

  return { projections, totalDelta, eoyBaseNet, eoyScenarioNet, needsReserves, reservesDraw, verdict };
}

// ── CC Spend Projection ──────────────────────────────────────────────────────
//
// Forecasts the open cycle's statement total:
//
//   projected = spent + planned
//             + (1 − F) · [Z · everydayPace + (1 − Z) · everydayNorm]   everyday spend still to come
//             + (1 − F) · bigNorm                                       big purchases still to come
//
//   F             share of a cycle's spend that has usually landed by today (ccCycleShare).
//                 Spend is front-loaded — bills, and charges still pending at the cut-off,
//                 land early — so a straight d/N line over-projects the rest of the cycle.
//   everydayPace  this cycle's spend net of logged big purchases, scaled up by F.
//   everydayNorm  mean closed-cycle total, less bigNorm.
//   bigNorm       mean logged big purchases per cycle. Logged purchases are one-offs: they
//                 count once in `spent` and are never extrapolated, so logging one moves the
//                 projection by exactly its amount.
//   Z             weight on this cycle's own pace, d / (d + PACE_CREDIBILITY_DAYS).
//   planned       estimated big purchases not swiped yet, added in full.
//
// The band covers only what is still to come, so it closes at the cut-off:
// ±BAND_Z · σ · √(1 − F), σ being the std-dev of the closed-cycle totals.
//
// The constants were fitted by replaying Jan 2025 – Aug 2026 card CSVs, forecasting every
// day of each cycle from earlier cycles only. Blending in the same cycle a year earlier
// made every variant worse: two years of data give each cycle one prior-year twin, and
// those are dominated by one-offs (a move, playoff tickets), not by season.

/** Closed cycles averaged into the norms — a full year, so every season counts once. */
const PRIOR_CYCLES = 12;
/** Days of pace worth as much as the norm. Tried 10–45: lower chases noise, higher drifts low. */
const PACE_CREDIBILITY_DAYS = 30;
/** Band half-width in σ·√(1 − F) units. Spend is fat-tailed: the normal 1.28 covered ~75%, 1.5 covers ~80%. */
const BAND_Z = 1.5;
/** With fewer complete CSV cycles than this, F falls back to a straight line. */
const MIN_CURVE_CYCLES = 6;

/** One statement cycle rebuilt day by day from card CSVs. */
export interface CCCycleSpend {
  month: string;    // cycle key — the month the statement closes in
  daily: number[];  // net spend per cycle day; daily[0] is the day after the previous cut-off
}

const epochDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/**
 * Rebuilds statement cycles from uploaded card CSVs. A charge belongs to the cycle it POSTS
 * in — that is what the statement shows — but sits on the day it was SWIPED, because the
 * live balance counts pending charges: a swipe on the cut-off day that posts after it is
 * already in the next cycle's day-1 balance. Only cycles that every card's upload fully
 * covers are returned; a partial one would read as a cheap month.
 */
export function ccCycleSpendFromCsv(
  rows:          { date: string; posted: string; spend: number }[],
  coverage:      { first: string; last: string }[],  // upload date span, one per card
  billingEndDay: number,
): CCCycleSpend[] {
  if (!coverage.length) return [];
  const from = coverage.reduce((m, c) => (c.first > m ? c.first : m), coverage[0].first);
  const to   = coverage.reduce((m, c) => (c.last  < m ? c.last  : m), coverage[0].last);

  const cycles = new Map<string, { start: number; daily: number[] } | null>();
  for (const r of rows) {
    const [y, m, d] = r.posted.split('-').map(Number);
    const month = openCycleMonth(new Date(y, m - 1, d), billingEndDay);
    let cycle = cycles.get(month);
    if (cycle === undefined) {
      const { start, end } = statementWindow(month, billingEndDay);
      cycle = start >= from && end <= to
        ? { start: epochDay(start), daily: new Array(epochDay(end) - epochDay(start) + 1).fill(0) }
        : null;
      cycles.set(month, cycle);
    }
    if (!cycle) continue;
    const day = Math.min(Math.max(epochDay(r.date) - cycle.start, 0), cycle.daily.length - 1);
    cycle.daily[day] += Number(r.spend);
  }

  return [...cycles]
    .flatMap(([month, c]) => (c ? [{ month, daily: c.daily }] : []))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * F(d): share of a cycle's spend that has usually landed by the end of day `daysElapsed` of a
 * `totalDays`-long cycle. Past cycles are stretched to the current cycle's length and pooled
 * as a ratio of sums, so no single odd month can swing the curve.
 */
export function ccCycleShare(cycles: CCCycleSpend[], daysElapsed: number, totalDays: number): number {
  let landed = 0;
  let total  = 0;
  for (const { daily } of cycles) {
    const x     = Math.min(daily.length, (daysElapsed / totalDays) * daily.length);
    const whole = Math.floor(x);
    for (let i = 0; i < whole; i++) landed += daily[i];
    if (whole < daily.length) landed += (x - whole) * daily[whole];
    total += daily.reduce((s, v) => s + v, 0);
  }
  return total > 0 ? Math.min(Math.max(landed / total, 0), 1) : daysElapsed / totalDays;
}

/** The parts of the projection that stay fixed while the page is open. */
export interface CCProjectionModel {
  share:        number;  // F
  paceWeight:   number;  // Z
  everydayNorm: number;
  bigNorm:      number;
  sigma:        number;
  cycles:       number;  // closed cycles behind the norms
}

export interface CCProjection {
  projected:    number;
  bandLow:      number;
  bandHigh:     number;
  everydayRest: number;  // everyday spend still to come
  bigRest:      number;  // typical big purchases still to come
}

/** Null until there are 3 closed cycles to learn from. */
export function buildCCProjectionModel(params: {
  statementTotals: { month: string; total: number }[];  // cc_variable_spend summed per cycle
  loggedBig:       { month: string; total: number }[];  // logged (not estimated) big purchases per cycle
  csvCycles:       CCCycleSpend[];
  openCycle:       string;  // history stops before the cycle still accumulating
  daysElapsed:     number;
  totalDays:       number;
}): CCProjectionModel | null {
  const { statementTotals, loggedBig, csvCycles, openCycle, daysElapsed, totalDays } = params;

  // Statement totals where recorded; CSV rebuilds (Chase cards only) for cycles before that.
  const byMonth = new Map<string, number>();
  for (const c of csvCycles)       byMonth.set(c.month, c.daily.reduce((s, v) => s + v, 0));
  for (const s of statementTotals) if (Number(s.total) > 0) byMonth.set(s.month, Number(s.total));
  const window = [...byMonth]
    .filter(([month, total]) => month < openCycle && total > 0)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, PRIOR_CYCLES);
  if (window.length < 3) return null;

  const totals = window.map(([, total]) => total);
  const norm   = totals.reduce((s, v) => s + v, 0) / totals.length;
  const sigma  = Math.sqrt(totals.reduce((s, v) => s + (v - norm) ** 2, 0) / (totals.length - 1));

  // Cycles from before big purchases were first logged still hold theirs, unlogged, inside
  // their totals — counting them as zero would understate the norm.
  const logged     = new Map(loggedBig.map(r => [r.month, Number(r.total)]));
  const firstLog   = [...logged.keys()].sort()[0];
  const loggedEra  = firstLog ? window.filter(([month]) => month >= firstLog) : [];
  const bigNorm    = loggedEra.length
    ? loggedEra.reduce((s, [month]) => s + (logged.get(month) ?? 0), 0) / loggedEra.length
    : 0;

  const share = csvCycles.length >= MIN_CURVE_CYCLES
    ? ccCycleShare(csvCycles, daysElapsed, totalDays)
    : Math.min(Math.max(daysElapsed / totalDays, 0), 1);

  return {
    share,
    paceWeight:   daysElapsed / (daysElapsed + PACE_CREDIBILITY_DAYS),
    everydayNorm: Math.max(0, norm - bigNorm),
    bigNorm,
    sigma,
    cycles:       totals.length,
  };
}

export function projectCCSpend(
  model: CCProjectionModel,
  now:   { spent: number; loggedBig: number; plannedBig: number },
): CCProjection {
  const { share, paceWeight, everydayNorm, bigNorm, sigma } = model;
  const everydayPace = share > 0 ? Math.max(0, now.spent - now.loggedBig) / share : everydayNorm;
  const everydayRest = (1 - share) * (paceWeight * everydayPace + (1 - paceWeight) * everydayNorm);
  const bigRest      = (1 - share) * bigNorm;
  const committed    = now.spent + now.plannedBig;
  const projected    = committed + everydayRest + bigRest;
  const bandHalf     = BAND_Z * sigma * Math.sqrt(1 - share);
  return {
    projected,
    bandLow:  Math.max(committed, projected - bandHalf),
    bandHigh: projected + bandHalf,
    everydayRest,
    bigRest,
  };
}

/** One-line breakdown shared by the server render and the client's live re-projection. */
export function describeCCProjection(p: CCProjection, now: { spent: number; plannedBig: number }): string {
  const parts = [`${fmtCurrency(now.spent)} spent`];
  if (now.plannedBig > 0)   parts.push(`${fmtCurrency(now.plannedBig)} planned`);
  if (p.everydayRest >= 0.5) parts.push(`${fmtCurrency(p.everydayRest)} everyday spend still to come`);
  if (p.bigRest >= 0.5)      parts.push(`${fmtCurrency(p.bigRest)} typical big purchases`);
  return parts.join(' + ');
}

// ── CC Baseline Comparisons ──────────────────────────────────────────────────

export function computeCCBudgetBaseline(
  summaries: { month: string; cc_budget: number }[],
  currentMonth: string,
  windowMonths = 12,
): { avg: number; nMonths: number } {
  const eligible = summaries
    .filter(s => s.month < currentMonth && Number(s.cc_budget) > 0)
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, windowMonths);
  if (eligible.length < 3) return { avg: 0, nMonths: 0 };
  const avg = eligible.reduce((s, r) => s + Number(r.cc_budget), 0) / eligible.length;
  return { avg, nMonths: eligible.length };
}

export function computeCCPaceBaseline(
  monthTotals: { month: string; total: number }[],
  currentMonth: string,
  windowMonths = 6,
): { avgMonthlyTotal: number; avgDailyRate: number; nMonths: number } {
  const eligible = monthTotals
    .filter(s => s.month < currentMonth && Number(s.total) > 0)
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, windowMonths);
  if (eligible.length < 2) return { avgMonthlyTotal: 0, avgDailyRate: 0, nMonths: 0 };
  const avgMonthlyTotal = eligible.reduce((s, r) => s + Number(r.total), 0) / eligible.length;
  return { avgMonthlyTotal, avgDailyRate: avgMonthlyTotal / 30, nMonths: eligible.length };
}

// ── Big Purchase Amortization ────────────────────────────────────────────────

export interface BigPurchaseAmortRow {
  category_id:       string;   // null rows stored as 'other'
  label:             string;
  color:             string;
  total:             number;
  count:             number;
  monthlyAmortized:  number;   // total / windowMonths
}

export interface BigPurchaseAmortResult {
  byCategory:        BigPurchaseAmortRow[];
  grandTotal:        number;
  monthlyAmortized:  number;   // grandTotal / windowMonths
  windowMonths:      number;
  annualReserveTarget: number; // monthlyAmortized * 12
}

const CAT_META: Record<string, { label: string; color: string }> = {
  travel:   { label: 'Travel',   color: '#0ea5e9' },
  home:     { label: 'Home',     color: '#84cc16' },
  rental:   { label: 'Rental',   color: '#8b5cf6' },
  shopping: { label: 'Shopping', color: '#f59e0b' },
  auto:     { label: 'Auto',     color: '#3b82f6' },
  medical:  { label: 'Medical',  color: '#f43f5e' },
  other:    { label: 'Other',    color: '#a8a29e' },
};

export function amortizeBigPurchases(
  charges: { category_id: string | null; amount: number }[],
  windowMonths: number,
): BigPurchaseAmortResult {
  const totals = new Map<string, { total: number; count: number }>();

  for (const c of charges) {
    const key = c.category_id ?? 'other';
    const cur = totals.get(key) ?? { total: 0, count: 0 };
    totals.set(key, { total: cur.total + c.amount, count: cur.count + 1 });
  }

  const wm = Math.max(1, windowMonths);
  const byCategory: BigPurchaseAmortRow[] = [...totals.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([id, { total, count }]) => ({
      category_id:      id,
      label:            CAT_META[id]?.label ?? id,
      color:            CAT_META[id]?.color ?? '#a8a29e',
      total,
      count,
      monthlyAmortized: total / wm,
    }));

  const grandTotal       = byCategory.reduce((s, r) => s + r.total, 0);
  const monthlyAmortized = grandTotal / wm;

  return {
    byCategory,
    grandTotal,
    monthlyAmortized,
    windowMonths:        wm,
    annualReserveTarget: monthlyAmortized * 12,
  };
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
