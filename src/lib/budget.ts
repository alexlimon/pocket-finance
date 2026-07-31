/** Budget-specific types and calculations (manual-entry system). */

export interface BigPurchaseCategory {
  id:    string;
  label: string;
  color: string; // hex color
}

export const BIG_PURCHASE_CATEGORIES: BigPurchaseCategory[] = [
  { id: 'travel',   label: 'Travel',   color: '#0ea5e9' }, // sky-500
  { id: 'home',     label: 'Home',     color: '#84cc16' }, // lime-500
  { id: 'rental',   label: 'Rental',   color: '#8b5cf6' }, // violet-500
  { id: 'shopping', label: 'Shopping', color: '#f59e0b' }, // amber-500
  { id: 'auto',     label: 'Auto',     color: '#3b82f6' }, // blue-500
  { id: 'medical',  label: 'Medical',  color: '#f43f5e' }, // rose-500
] as const;

export function bigPurchaseCategoryColor(id: string | null | undefined): string {
  return BIG_PURCHASE_CATEGORIES.find(c => c.id === id)?.color ?? '#a8a29e'; // stone-400 fallback
}

export interface MonthlySummary {
  month:           string;
  income_alex:     number;
  income_maham:    number;
  income_other:    number;
  checking_before: number;
  checking_after:  number;
  savings_before:  number;
  savings_after:   number;
  cc_budget:       number;
  notes:           string | null;
}

export interface BillConfig {
  id:               string;
  name:             string;
  monthly_target:   number | null;
  due_day:          number | null;
  is_recurring:     number;
  is_cc_default:    number;
  entity_id:        string;
  category_id:      string | null;
}

export interface BillPayment {
  id:         string;
  month:      string;
  bill_id:    string;
  amount:     number;
  is_paid:    number;
  is_cc:      number;
  paid_date:  string | null;
}

export interface BillRow extends BillConfig {
  // Payment status for the selected month (null = no payment record yet)
  payment_id:     string | null;
  actual_amount:  number;   // payment amount if paid, else monthly_target
  is_paid:        number;
  is_cc:          number;
  is_skipped:     boolean;
}

export interface CCCharge {
  id:              string;
  month:           string;
  date:            string | null;
  description:     string;
  amount:          number;
  card:            string;
  is_big_purchase: number;
  category_id:     string | null;
}

export interface CashExpense {
  id:          string;
  month:       string;
  date:        string | null;
  description: string;
  amount:      number;
  type:        'expense' | 'income';
  entity_id:   string;
}

export function totalIncome(s: MonthlySummary): number {
  // income_other is legacy (Kirby rent) — now tracked via cash_expenses income rows.
  return s.income_alex + s.income_maham;
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function fmt(n: number, opts?: { sign?: boolean; compact?: boolean }): string {
  return new Intl.NumberFormat('en-US', {
    style:                 'currency',
    currency:              'USD',
    notation:              opts?.compact ? 'compact' : 'standard',
    minimumFractionDigits: 2,
    maximumFractionDigits: opts?.compact ? 1 : 2,
    signDisplay:           opts?.sign ? 'always' : 'auto',
  }).format(n);
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  return new Date(Number(y), Number(m) - 1, 1)
    .toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

export function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ── CC Recurring billing-cycle helpers ────────────────────────────────────────

/**
 * Given the month a subscription charge *occurs* (billingMonth) and the card's
 * billing cut-off day (billingEndDay), returns the YYYY-MM in which the CC
 * payment that covers that charge is due.
 *
 *  dueDay <= billingEndDay  →  charge lands in this billing cycle  →  pay next month
 *  dueDay >  billingEndDay  →  charge spills into next billing cycle →  pay month after
 */
/**
 * Returns the inclusive date range of the CC billing cycle that ends on `billingEndDay`
 * of `billingMonth`. Used to find CSV transactions that map to a given payment month.
 *
 * E.g. billingMonth='2026-05', billingEndDay=24 → { start:'2026-04-25', end:'2026-05-24' }
 * Caller should pass prevMonth(paymentMonth) as billingMonth.
 */
export function statementWindow(billingMonth: string, billingEndDay: number): { start: string; end: string } {
  const [y, m] = billingMonth.split('-').map(Number);
  const end  = new Date(Date.UTC(y, m - 1, billingEndDay));
  const prev = new Date(Date.UTC(y, m - 2, billingEndDay));
  prev.setUTCDate(prev.getUTCDate() + 1);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(prev), end: fmt(end) };
}

export function ccSubPaymentMonth(
  dueDay: number | null,
  billingEndDay: number,
  billingMonth: string,
): string | null {
  if (dueDay === null) return null;
  const [yr, mo] = billingMonth.split('-').map(Number);
  // mo is 1-indexed; JS Date month is 0-indexed, so passing mo directly = +1 month
  const d = dueDay <= billingEndDay
    ? new Date(yr, mo, 1)       // next month relative to billingMonth
    : new Date(yr, mo + 1, 1);  // two months out
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Returns true when this subscription's charge falls in the CC billing cycle
 * whose payment is made in `paymentMonth`.
 *
 * Two cases:
 *  - dueDay <= billingEndDay: billed in prevMonth(paymentMonth) → paid in paymentMonth
 *  - dueDay >  billingEndDay: billed in prevPrevMonth(paymentMonth) → paid in paymentMonth
 *
 * Bills without a due_day cannot be auto-assigned and are always included.
 */
export function ccSubIsInPaymentMonth(
  dueDay: number | null,
  billingEndDay: number,
  paymentMonth: string,
): boolean {
  if (dueDay === null) return true; // no due day → show every month (manual control)
  const pm1 = ccSubPaymentMonth(dueDay, billingEndDay, prevMonth(paymentMonth));
  const pm2 = ccSubPaymentMonth(dueDay, billingEndDay, prevMonth(prevMonth(paymentMonth)));
  return pm1 === paymentMonth || pm2 === paymentMonth;
}
