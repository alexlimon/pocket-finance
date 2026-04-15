/**
 * budget-calc.ts — Pure business-logic functions for the monthly budget page.
 *
 * Each function has a single goal and no side effects.
 * The budget.astro frontmatter calls these after fetching raw DB data.
 */

import {
  totalIncome, prevMonth, ccSubIsInPaymentMonth,
  type MonthlySummary, type BillRow, type CCCharge, type CashExpense,
} from './budget';

// ── Shared types ─────────────────────────────────────────────────────────────

export type ResolvedBill = BillRow & { effective_paid: boolean; is_auto: boolean };
export type BigPurchase  = CCCharge & { payment_month: string | null };

// ── 1. resolveBillStatus ──────────────────────────────────────────────────────
/**
 * Turns raw DB join rows (budget_config LEFT JOIN bill_payments) into bills with
 * a resolved `effective_paid` flag.
 *
 * Priority: explicit DB record > auto-check (only on the current month, past due_day).
 * Future months never auto-check.
 */
export function resolveBillStatus(
  rows:      any[],
  isNow:     boolean,
  todayDay:  number,
  allowAuto: boolean = true,
): ResolvedBill[] {
  return rows.map(r => {
    const hasExplicit   = Number(r.explicit_paid) !== -1;
    const explicitPaid  = hasExplicit ? !!Number(r.explicit_paid) : false;
    const isAuto        = allowAuto && isNow && !hasExplicit && r.due_day !== null && todayDay >= Number(r.due_day);
    const effectivePaid = hasExplicit ? explicitPaid : isAuto;
    return {
      ...r,
      actual_amount:  effectivePaid ? Number(r.paid_amount ?? r.monthly_target ?? 0) : Number(r.monthly_target ?? 0),
      is_paid:        effectivePaid ? 1 : 0,
      is_cc:          Number(r.is_cc),
      effective_paid: effectivePaid,
      is_auto:        isAuto,
      is_skipped:     Number(r.is_skipped) === 1,
    } as ResolvedBill;
  });
}

// ── 2. categorizeBills ────────────────────────────────────────────────────────
/**
 * Splits resolved bills into two groups:
 *  - checkingBills: paid from checking account (not CC, not the CC payment entry itself)
 *  - ccBills:       CC recurring subscriptions
 *
 * The "CC Payment" row in budget_config is excluded because we compute that amount
 * from cc_budget + recurring budget rather than from a bill record.
 */
const CC_PAYMENT_PATTERN = /cc\s*payment|credit\s*card\s*payment/i;

export function categorizeBills(bills: ResolvedBill[]): {
  checkingBills: ResolvedBill[];
  ccBills:       ResolvedBill[];
} {
  return {
    checkingBills: bills.filter(b => !b.is_cc_default && !CC_PAYMENT_PATTERN.test(b.name) && !b.is_skipped),
    ccBills:       bills.filter(b =>  !!b.is_cc_default && !b.is_skipped),
  };
}

// ── 3. groupBigPurchasesByPayMonth ────────────────────────────────────────────
/**
 * Groups big purchases by the month they'll be paid out of checking, sorted
 * chronologically (unknown payment months go last).
 */
export function groupBigPurchasesByPayMonth(
  bigPurchases: BigPurchase[],
): [payMonth: string, charges: BigPurchase[]][] {
  const byMonth = new Map<string, BigPurchase[]>();
  for (const c of bigPurchases) {
    const key = c.payment_month ?? 'unknown';
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key)!.push(c);
  }
  return [...byMonth.entries()].sort(([a], [b]) => {
    if (a === 'unknown') return 1;
    if (b === 'unknown') return -1;
    return a.localeCompare(b);
  });
}

// ── 4. computeCCPayment ───────────────────────────────────────────────────────
/**
 * Computes the total CC payment leaving checking this month.
 *
 * Convention (spreadsheet "payment-month" model):
 *   cc_budget[M]           = variable component paid in month M (last month's variable spend)
 *   cc_recurring_budget[M] = recurring component paid in month M (last billing cycle's subs)
 *   CC payment[M]          = cc_budget[M] + recurring component
 *
 * The recurring component switches from "estimated" (sum of monthly_targets) to "actual"
 * (sum of paid amounts) once all subs in this payment cycle are checked off.
 */
export function computeCCPayment(params: {
  ccBills:         ResolvedBill[];
  billingEndDay:   number;
  paymentMonth:    string;   // the month whose payment we're computing (= current month)
  ccVariableBudget: number;  // summary.cc_budget for this month
}): {
  ccBillsForPayment:          ResolvedBill[];
  estimatedPaymentRecurring:  number;
  actualPaymentRecurring:     number;
  recurringMode:              'estimated' | 'actual';
  recurringBudget:            number;
  ccPaymentAmount:            number;
} {
  const { ccBills, billingEndDay, paymentMonth, ccVariableBudget } = params;

  // Subs whose billing cycle closed before this month's payment date
  const ccBillsForPayment = ccBills.filter(b =>
    ccSubIsInPaymentMonth(b.due_day ? Number(b.due_day) : null, billingEndDay, paymentMonth)
  );

  const estimatedPaymentRecurring = ccBillsForPayment.reduce((s, b) => s + Number(b.monthly_target ?? 0), 0);
  const actualPaymentRecurring    = ccBillsForPayment.filter(b => b.effective_paid).reduce((s, b) => s + b.actual_amount, 0);

  const allChecked    = ccBillsForPayment.length > 0 && ccBillsForPayment.every(b => b.effective_paid);
  const recurringMode = allChecked ? 'actual' : 'estimated' as const;
  const recurringBudget = recurringMode === 'actual' ? actualPaymentRecurring : estimatedPaymentRecurring;

  return {
    ccBillsForPayment,
    estimatedPaymentRecurring,
    actualPaymentRecurring,
    recurringMode,
    recurringBudget,
    ccPaymentAmount: ccVariableBudget + recurringBudget,
  };
}

// ── 5. computeCCSpendingTracker ───────────────────────────────────────────────
/**
 * Computes the CC spending budget and tracker for this month's discretionary spending.
 *
 * Spending budget = next month's cc_budget (this month's spending will be paid next month).
 *
 * The tracker shows:
 *   - ccVariableOnly: variable spend minus recurring subs (true discretionary)
 *   - ccBig:          big purchases
 *   - ccUsed:         ccVariableOnly + ccBig  (what counts against the budget)
 *   - ccRemaining:    ccSpendBudget - ccUsed
 *
 * ccBillsNextPayment = subs billed this cycle, tracked in next month's bill_payments.
 * We use those rows so paid-state reflects what's actually been checked off for next month's payment.
 */
export function computeCCSpendingTracker(params: {
  nextBills:          ResolvedBill[];
  billingEndDay:      number;
  nextMonth:          string;
  variableSpendRows:  { card: string; amount: number }[];
  bigPurchases:       BigPurchase[];
  nextMonthCCBudget:  number | null;
  currentCCBudget:    number;
  savedDisplayMode?:  'estimated' | 'actual' | null;
}): {
  ccBillsNextPayment:  ResolvedBill[];
  estimatedCCRecurring: number;
  actualCCRecurring:    number;
  allCCRecurringChecked: boolean;
  ccDisplayMode:        'estimated' | 'actual';
  ccRecurringInVariable: number;
  variableSpendMap:     Map<string, number>;
  ccVariableTotal:      number;
  ccVariableOnly:       number;
  ccBig:                number;
  ccUsed:               number;
  ccSpendBudget:        number;
  ccRemaining:          number;
  ccUsedPct:            number;
} {
  const { nextBills, billingEndDay, nextMonth, variableSpendRows, bigPurchases, nextMonthCCBudget, currentCCBudget } = params;

  // Spending budget: next month's cc_budget is what will be paid for this month's spending
  const ccSpendBudget = nextMonthCCBudget ?? currentCCBudget;

  // Subs billed this cycle, paid next month
  const ccBillsNextPayment = nextBills.filter(b =>
    !b.is_skipped &&
    ccSubIsInPaymentMonth(b.due_day ? Number(b.due_day) : null, billingEndDay, nextMonth)
  );

  const estimatedCCRecurring   = ccBillsNextPayment.reduce((s, b) => s + Number(b.monthly_target ?? 0), 0);
  const actualCCRecurring      = ccBillsNextPayment.filter(b => b.effective_paid).reduce((s, b) => s + b.actual_amount, 0);
  const allCCRecurringChecked  = ccBillsNextPayment.length > 0 && ccBillsNextPayment.every(b => b.effective_paid);
  const ccDisplayMode          = (params.savedDisplayMode ?? (allCCRecurringChecked ? 'actual' : 'estimated')) as 'estimated' | 'actual';
  const ccRecurringInVariable  = ccDisplayMode === 'actual' ? actualCCRecurring : estimatedCCRecurring;

  // Per-card variable spend map (for display)
  const variableSpendMap  = new Map(variableSpendRows.map(r => [r.card, Number(r.amount)]));
  const ccVariableTotal   = [...variableSpendMap.values()].reduce((s, v) => s + v, 0);
  const ccVariableOnly    = Math.max(0, ccVariableTotal - ccRecurringInVariable);
  const ccBig             = bigPurchases.reduce((s, c) => s + c.amount, 0);
  const ccUsed            = ccVariableOnly + ccBig;
  const ccRemaining       = ccSpendBudget - ccUsed;
  const ccUsedPct         = Math.min((ccUsed / ccSpendBudget) * 100, 100);

  return {
    ccBillsNextPayment,
    estimatedCCRecurring,
    actualCCRecurring,
    allCCRecurringChecked,
    ccDisplayMode,
    ccRecurringInVariable,
    variableSpendMap,
    ccVariableTotal,
    ccVariableOnly,
    ccBig,
    ccUsed,
    ccSpendBudget,
    ccRemaining,
    ccUsedPct,
  };
}

// ── 6. computeCashFlow ────────────────────────────────────────────────────────
/**
 * Computes monthly NET cash flow.
 *
 * NET = (salaries + other cash income) − fixed checking bills − CC payment − other cash expenses
 *
 * "Other cash" entries come from the cash_expenses table (type = 'income' or 'expense').
 * Salaries (income_alex + income_maham) come from monthly_summary.
 */
export function computeCashFlow(params: {
  summary:          MonthlySummary;
  checkingBills:    ResolvedBill[];
  ccPaymentAmount:  number;
  cashExpenses:     CashExpense[];
}): {
  otherCashIncomes:      CashExpense[];
  otherCashExpenses:     CashExpense[];
  otherCashIncomeTotal:  number;
  otherCashExpenseTotal: number;
  totalFixedChecking:    number;
  incomeTotal:           number;
  netAmount:             number;
} {
  const { summary, checkingBills, ccPaymentAmount, cashExpenses } = params;

  const otherCashIncomes      = cashExpenses.filter(e => e.type === 'income');
  const otherCashExpenses     = cashExpenses.filter(e => e.type === 'expense');
  const otherCashIncomeTotal  = otherCashIncomes.reduce((s, e) => s + e.amount, 0);
  const otherCashExpenseTotal = otherCashExpenses.reduce((s, e) => s + e.amount, 0);
  const totalFixedChecking    = checkingBills.reduce((s, b) => s + b.actual_amount, 0);
  const incomeTotal           = totalIncome(summary); // alex + maham salaries only

  const netAmount = incomeTotal + otherCashIncomeTotal - totalFixedChecking - ccPaymentAmount - otherCashExpenseTotal;

  return {
    otherCashIncomes,
    otherCashExpenses,
    otherCashIncomeTotal,
    otherCashExpenseTotal,
    totalFixedChecking,
    incomeTotal,
    netAmount,
  };
}

// ── 7. computeBalances ────────────────────────────────────────────────────────
/**
 * Projects end-of-month checking and savings balances.
 *
 * checkingEnd = checkingStart + NET − savingsAllocation
 * savingsEnd  = savingsStart  + savingsAllocation
 *
 * savingsAllocation is derived from the stored end balance (user edits savings_after directly).
 */
export function computeBalances(summary: MonthlySummary, netAmount: number): {
  checkingStart:     number;
  checkingEnd:       number;
  savingsStart:      number;
  savingsEnd:        number;
  savingsAllocation: number;
} {
  const checkingStart     = Number(summary.checking_before);
  const savingsStart      = Number(summary.savings_before);
  const savingsAllocation = Number(summary.savings_after) - savingsStart;
  const checkingEnd       = checkingStart + netAmount - savingsAllocation;
  const savingsEnd        = savingsStart + savingsAllocation;

  return { checkingStart, checkingEnd, savingsStart, savingsEnd, savingsAllocation };
}

// ── 8. subBillingMonth ────────────────────────────────────────────────────────
/**
 * For a CC recurring sub displayed in the "billed this cycle" section,
 * returns the calendar month the charge actually hits the card.
 *
 *   due_day <= billingEndDay  →  billed this month (within the current cycle)
 *   due_day >  billingEndDay  →  billed last month (rolled into the next cycle)
 */
export function subBillingMonth(
  bill:          Pick<BillRow, 'due_day'>,
  billingEndDay: number,
  currentMonth:  string,
): string | null {
  if (!bill.due_day) return null;
  return Number(bill.due_day) <= billingEndDay ? currentMonth : prevMonth(currentMonth);
}
