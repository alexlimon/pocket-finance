/** Core financial calculations — deterministic, no DB calls. */

export interface AccountRow {
  id:               string;
  name:             string;
  type:             string;
  current_balance:  number;
  entity_id:        string;
}

export interface TransactionRow {
  id:           string;
  account_id:   string;
  date:         string;
  amount:       number;       // positive = expense, negative = income
  merchant_clean: string | null;
  category_id:  string | null;
  entity_id:    string;
  is_pending:   number;
  is_hidden:    number;
}

export interface BudgetRow {
  id:             string;
  category_id:    string | null;
  name:           string;
  monthly_target: number | null;
  due_day:        number | null;
  is_recurring:   number;
  entity_id:      string;
}

export interface IncomeRow {
  id:           string;
  name:         string;
  amount:       number;
  frequency:    string;
  expected_day: number | null;
  entity_id:    string;
  is_active:    boolean | number;
}

// ── Balance helpers ──────────────────────────────────────────────────────────

/** Sum of all checking + savings balances. */
export function totalCash(accounts: AccountRow[]): number {
  return accounts
    .filter(a => a.type === 'checking' || a.type === 'savings')
    .reduce((sum, a) => sum + (a.current_balance ?? 0), 0);
}

/** Sum of all credit card balances (what is owed). */
export function totalCreditDebt(accounts: AccountRow[]): number {
  return accounts
    .filter(a => a.type === 'credit')
    .reduce((sum, a) => sum + Math.max(0, a.current_balance ?? 0), 0);
}

/** Net liquid position: cash minus credit card balances. */
export function netCash(accounts: AccountRow[]): number {
  return totalCash(accounts) - totalCreditDebt(accounts);
}

// ── Monthly metrics ──────────────────────────────────────────────────────────

function isoMonth(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Total spending for the current calendar month (positive Plaid amounts). */
export function monthlySpending(
  transactions: TransactionRow[],
  entityId?: string,
  month?: string,
): number {
  const m = month ?? isoMonth();
  return transactions
    .filter(t =>
      !t.is_hidden &&
      !t.is_pending &&
      t.amount > 0 &&
      t.date.startsWith(m) &&
      (entityId == null || t.entity_id === entityId),
    )
    .reduce((sum, t) => sum + t.amount, 0);
}

/** Total income (credit deposits) for the current calendar month. */
export function monthlyIncome(
  transactions: TransactionRow[],
  entityId?: string,
  month?: string,
): number {
  const m = month ?? isoMonth();
  return transactions
    .filter(t =>
      !t.is_hidden &&
      t.amount < 0 &&
      t.date.startsWith(m) &&
      (entityId == null || t.entity_id === entityId),
    )
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);
}

/** Average monthly spending over the last N complete months. */
export function avgMonthlyBurn(transactions: TransactionRow[], months = 3): number {
  const now     = new Date();
  const buckets: Record<string, number> = {};

  for (let i = 1; i <= months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets[isoMonth(d)] = 0;
  }

  for (const t of transactions) {
    if (t.is_hidden || t.is_pending || t.amount <= 0) continue;
    const m = t.date.slice(0, 7);
    if (m in buckets) buckets[m] += t.amount;
  }

  const values = Object.values(buckets);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

// ── Safe to Spend ────────────────────────────────────────────────────────────

export interface UpcomingBill {
  name:       string;
  amount:     number;
  dueDay:     number;
  daysUntil:  number;
  entityId:   string;
}

/** Bills due within the next 30 days that haven't cleared this month. */
export function upcomingBills(
  budgets: BudgetRow[],
  transactions: TransactionRow[],
  today: Date = new Date(),
): UpcomingBill[] {
  const results: UpcomingBill[] = [];
  const currentMonth = isoMonth(today);

  for (const b of budgets) {
    if (!b.is_recurring || !b.due_day || !b.monthly_target) continue;

    // Check if this bill has already cleared this month
    const cleared = transactions.some(
      t =>
        !t.is_pending &&
        t.date.startsWith(currentMonth) &&
        t.category_id === b.category_id &&
        Math.abs(t.amount - b.monthly_target!) < 1,
    );
    if (cleared) continue;

    // Calculate days until next due date
    const dueDate = new Date(today.getFullYear(), today.getMonth(), b.due_day);
    if (dueDate < today) {
      dueDate.setMonth(dueDate.getMonth() + 1);
    }
    const daysUntil = Math.ceil((dueDate.getTime() - today.getTime()) / 86_400_000);

    if (daysUntil <= 30) {
      results.push({
        name:      b.name,
        amount:    b.monthly_target,
        dueDay:    b.due_day,
        daysUntil,
        entityId:  b.entity_id,
      });
    }
  }

  return results.sort((a, b) => a.daysUntil - b.daysUntil);
}

/** Safe to spend = net cash minus sum of upcoming bills not yet cleared. */
export function safeToSpend(
  accounts:     AccountRow[],
  budgets:      BudgetRow[],
  transactions: TransactionRow[],
  today?:       Date,
): { amount: number; bills: UpcomingBill[] } {
  const bills   = upcomingBills(budgets, transactions, today);
  const reserve = bills.reduce((sum, b) => sum + b.amount, 0);
  return { amount: netCash(accounts) - reserve, bills };
}

// ── Status light ─────────────────────────────────────────────────────────────

export type StatusLight = 'green' | 'yellow' | 'red';

/** Compute the household's overall health indicator. */
export function statusLight(params: {
  safeToSpendAmount: number;
  bills: UpcomingBill[];
  currentMonthlySpend: number;
  monthlyBudgetTarget: number;
}): StatusLight {
  const { safeToSpendAmount, bills, currentMonthlySpend, monthlyBudgetTarget } = params;

  if (safeToSpendAmount < 0) return 'red';

  const hasBillDueSoon = bills.some(b => b.daysUntil <= 7);
  if (hasBillDueSoon) return 'yellow';

  const isOverBudget = monthlyBudgetTarget > 0 &&
    currentMonthlySpend > monthlyBudgetTarget * 1.2;
  if (isOverBudget) return 'red';

  return 'green';
}

// ── Year-end projection ───────────────────────────────────────────────────────

export interface EOYProjection {
  projectedBalance:     number;
  projectedWithPurchase: number;
  monthsRemaining:      number;
  currentSavings:       number;
  avgMonthlyNet:        number;
}

export function eoyProjection(params: {
  accounts:          AccountRow[];
  transactions:      TransactionRow[];
  incomeSources:     IncomeRow[];
  purchaseCost?:     number;
  today?:            Date;
}): EOYProjection {
  const { accounts, transactions, incomeSources, purchaseCost = 0, today = new Date() } = params;

  const currentSavings = totalCash(accounts);
  const monthlyIncomeExpected = incomeSources
    .filter(s => s.is_active && s.frequency === 'monthly')
    .reduce((sum, s) => sum + s.amount, 0);

  const burn           = avgMonthlyBurn(transactions, 3);
  const avgMonthlyNet  = monthlyIncomeExpected - burn;
  const monthsRemaining = Math.max(0, 12 - today.getMonth()); // months left incl. current

  const projectedBalance      = currentSavings + avgMonthlyNet * monthsRemaining;
  const projectedWithPurchase = projectedBalance - purchaseCost;

  return { projectedBalance, projectedWithPurchase, monthsRemaining, currentSavings, avgMonthlyNet };
}

// ── Property P&L ─────────────────────────────────────────────────────────────

export interface PropertyPL {
  entityId:        string;
  monthlyIncome:   number;
  monthlyExpenses: number;
  netCashFlow:     number;
}

export function propertyPL(
  transactions: TransactionRow[],
  entityId: string,
  month?: string,
): PropertyPL {
  const income   = monthlyIncome(transactions, entityId, month);
  const expenses = monthlySpending(transactions, entityId, month);
  return { entityId, monthlyIncome: income, monthlyExpenses: expenses, netCashFlow: income - expenses };
}

// ── Budget progress ───────────────────────────────────────────────────────────

export interface BudgetProgress {
  budgetId:    string;
  name:        string;
  target:      number;
  spent:       number;
  pct:         number;    // 0–1 (may exceed 1 if over budget)
  isOver:      boolean;
}

export function budgetProgress(
  budgets:      BudgetRow[],
  transactions: TransactionRow[],
  month?:       string,
): BudgetProgress[] {
  const m = month ?? isoMonth();
  return budgets
    .filter(b => b.monthly_target && b.monthly_target > 0 && b.category_id)
    .map(b => {
      const spent = transactions
        .filter(t =>
          !t.is_hidden &&
          !t.is_pending &&
          t.amount > 0 &&
          t.date.startsWith(m) &&
          t.category_id === b.category_id,
        )
        .reduce((sum, t) => sum + t.amount, 0);

      const pct = b.monthly_target! > 0 ? spent / b.monthly_target! : 0;
      return {
        budgetId: b.id,
        name:     b.name,
        target:   b.monthly_target!,
        spent,
        pct,
        isOver:   pct > 1,
      };
    })
    .sort((a, b) => b.pct - a.pct);
}

// ── Formatting helpers ────────────────────────────────────────────────────────

export function formatCurrency(
  amount: number,
  opts?: { sign?: boolean; compact?: boolean },
): string {
  const fmt = new Intl.NumberFormat('en-US', {
    style:                 'currency',
    currency:              'USD',
    notation:              opts?.compact ? 'compact' : 'standard',
    minimumFractionDigits: opts?.compact ? 0 : 2,
    maximumFractionDigits: opts?.compact ? 1 : 2,
    signDisplay:           opts?.sign ? 'always' : 'auto',
  });
  return fmt.format(amount);
}
