/** Core financial calculations — deterministic, no DB calls. */

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