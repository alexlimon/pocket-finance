import { getClient } from './db';
import { getAccounts, getInstitutionName } from './plaid';

const CARD_MAP: { match: (n: string) => boolean; card: string }[] = [
  { match: (n) => n.includes('Ultimate Rewards') || n.includes('Sapphire'), card: 'sapphire' },
  { match: (n) => n.includes('Prime Visa'),                                 card: 'prime' },
];

function yyyyMM(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function nextMonthDate(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

interface CardSettings {
  billing_end_day: number;
  payment_day:     number;
}

interface SpendEntry {
  month:              string;
  amount:             number;
  /** Only set for the current-month entry in Phase 2 — the locked statement balance to snapshot. */
  statementBalance:   number | null;
  balanceUpdatedAt:   string | null;
}

interface SpendWrites {
  entries: SpendEntry[];
}

/**
 * Determines which month(s) to write CC variable spend to, and how much.
 *
 * Phase 1 — Normal accumulation (day 1 → billing_end_day - 1):
 *   current month ← limit - available
 *
 * Phase 2 — Statement closed, payment pending (billing_end_day → payment_day of next month):
 *   current month ← existingStatementBalance (locked on first Phase 2 sync, never updated again)
 *   next month    ← max(0, (limit - available) - settled)  (post-statement charges)
 *
 *   existingStatementBalance is read from the DB before calling this function. If null (first
 *   time entering Phase 2), Plaid's live `current` is snapshotted as the statement balance.
 *   COALESCE in the upsert SQL ensures subsequent syncs never overwrite a stored snapshot.
 *
 * Phase 3 — After payment (after payment_day of next month):
 *   next month ← limit - available  (fresh cycle, no subtraction needed)
 */
function computeSpendWrites(
  current: number,
  available: number,
  limit: number,
  settings: CardSettings,
  existingStatementBalance: number | null,
  balanceUpdatedAt: string | null,
): SpendWrites {
  const today      = new Date();
  const day        = today.getDate();
  const thisMonth  = yyyyMM(today);
  const next       = nextMonthDate(today);
  const nextMonth  = yyyyMM(next);
  const totalUsed  = Math.round((limit - available) * 100) / 100;
  const { billing_end_day, payment_day } = settings;

  // Phase 1: before statement closes
  if (day < billing_end_day) {
    return { entries: [{ month: thisMonth, amount: totalUsed, statementBalance: null, balanceUpdatedAt }] };
  }

  // Determine if we're past the payment date in the next calendar month.
  const paymentDate = new Date(next.getFullYear(), next.getMonth(), payment_day);
  const pastPayment = today >= paymentDate;

  // Phase 3: after payment — fresh cycle
  if (pastPayment) {
    return { entries: [{ month: nextMonth, amount: totalUsed, statementBalance: null, balanceUpdatedAt }] };
  }

  // Phase 2: statement closed, payment still pending.
  // Use the stored snapshot if available; otherwise snapshot Plaid's live current balance.
  const settled       = existingStatementBalance !== null
    ? existingStatementBalance
    : Math.round(current * 100) / 100;
  const postStatement = Math.max(0, Math.round((totalUsed - settled) * 100) / 100);

  return {
    entries: [
      { month: thisMonth, amount: settled, statementBalance: settled, balanceUpdatedAt },
      { month: nextMonth, amount: postStatement, statementBalance: null, balanceUpdatedAt },
    ],
  };
}

export async function syncCCSpend(env: CloudflareEnv): Promise<void> {
  const client = getClient(env);
  try {
    const settingsRes = await client.execute({ sql: 'SELECT card, billing_end_day, payment_day FROM cc_settings', args: [] });
    const settingsMap = new Map<string, CardSettings>(
      settingsRes.rows.map(r => [
        String(r.card),
        { billing_end_day: Number(r.billing_end_day), payment_day: Number(r.payment_day) },
      ])
    );

    // Pre-load stored statement_balances for the current month so Phase 2 uses the snapshot.
    const thisMonth = yyyyMM(new Date());
    const sbRes = await client.execute({
      sql:  'SELECT card, statement_balance FROM cc_variable_spend WHERE month = ?',
      args: [thisMonth],
    });
    const storedStatementBalances = new Map<string, number | null>(
      sbRes.rows.map(r => [
        String(r.card),
        r.statement_balance !== null && r.statement_balance !== undefined
          ? Number(r.statement_balance)
          : null,
      ])
    );

    const items = await client.execute({ sql: 'SELECT id, access_token, institution_name FROM plaid_items', args: [] });
    let anyError: string | null = null;

    for (const item of items.rows) {
      const accessToken = String(item.access_token);

      let accounts: Awaited<ReturnType<typeof getAccounts>>;
      try {
        accounts = await getAccounts(accessToken, env);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        anyError = msg.includes('ITEM_LOGIN_REQUIRED') ? 'ITEM_LOGIN_REQUIRED' : 'SYNC_ERROR';
        continue;
      }

      // Backfill institution_name if missing
      if (!item.institution_name) {
        const name = await getInstitutionName(accessToken, env).catch(() => null);
        if (name) {
          await client.execute({
            sql:  'UPDATE plaid_items SET institution_name = ? WHERE id = ?',
            args: [name, String(item.id)],
          });
        }
      }

      for (const acct of accounts) {
        if (acct.type !== 'credit') continue;
        const mapping = CARD_MAP.find(m => m.match(acct.official_name ?? ''));
        if (!mapping) continue;

        const settings = settingsMap.get(mapping.card);
        if (!settings) continue;

        const existingSB      = storedStatementBalances.get(mapping.card) ?? null;
        const balanceUpdatedAt = acct.balances.balance_last_updated ?? null;

        const { entries } = computeSpendWrites(
          acct.balances.current   ?? 0,
          acct.balances.available ?? 0,
          acct.balances.limit     ?? 0,
          settings,
          existingSB,
          balanceUpdatedAt,
        );

        for (const { month, amount, statementBalance, balanceUpdatedAt: bua } of entries) {
          await client.execute({
            sql:  `INSERT INTO cc_variable_spend (month, card, amount, statement_balance, balance_updated_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
                   ON CONFLICT(month, card) DO UPDATE SET
                     amount = excluded.amount,
                     statement_balance    = COALESCE(cc_variable_spend.statement_balance, excluded.statement_balance),
                     balance_updated_at   = excluded.balance_updated_at,
                     updated_at           = excluded.updated_at`,
            args: [month, mapping.card, amount, statementBalance, bua],
          });
        }
      }

      await client.execute({
        sql:  `UPDATE plaid_items SET last_synced = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
        args: [String(item.id)],
      });
    }

    // Persist or clear sync error so the UI can surface it on next page load
    if (anyError) {
      await client.execute({
        sql:  `INSERT OR REPLACE INTO settings (key, value) VALUES ('plaid_sync_error', ?)`,
        args: [anyError],
      });
    } else {
      await client.execute({ sql: `DELETE FROM settings WHERE key = 'plaid_sync_error'`, args: [] });
    }
  } finally {
    client.close();
  }
}
