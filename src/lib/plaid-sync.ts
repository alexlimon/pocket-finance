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

interface SpendWrites {
  /** month → amount pairs to upsert into cc_variable_spend */
  entries: { month: string; amount: number }[];
}

/**
 * Determines which month(s) to write CC variable spend to, and how much.
 *
 * Phase 1 — Normal accumulation (day 1 → billing_end_day - 1):
 *   current month ← limit - available
 *
 * Phase 2 — Statement closed, payment pending (billing_end_day → payment_day of next month):
 *   current month ← current_balance  (locked settled statement)
 *   next month    ← max(0, (limit - available) - current_balance)  (post-statement charges)
 *
 * Phase 3 — After payment (after payment_day of next month):
 *   next month ← limit - available  (fresh cycle, no subtraction needed)
 */
function computeSpendWrites(
  current: number,
  available: number,
  limit: number,
  settings: CardSettings,
): SpendWrites {
  const today      = new Date();
  const day        = today.getDate();
  const thisMonth  = yyyyMM(today);
  const next       = nextMonthDate(today);
  const nextMonth  = yyyyMM(next);
  const totalUsed  = Math.round((limit - available) * 100) / 100;
  const settled    = Math.round(current * 100) / 100;
  const { billing_end_day, payment_day } = settings;

  // Phase 1: before statement closes
  if (day < billing_end_day) {
    return { entries: [{ month: thisMonth, amount: totalUsed }] };
  }

  // Determine if we're past the payment date in the next calendar month.
  // payment_day refers to a day in the next calendar month relative to billing_end_day.
  const paymentDate = new Date(next.getFullYear(), next.getMonth(), payment_day);
  const pastPayment = today >= paymentDate;

  // Phase 3: after payment — fresh cycle
  if (pastPayment) {
    return { entries: [{ month: nextMonth, amount: totalUsed }] };
  }

  // Phase 2: statement closed, payment still pending
  const postStatement = Math.max(0, Math.round((totalUsed - settled) * 100) / 100);
  return {
    entries: [
      { month: thisMonth, amount: settled },
      { month: nextMonth, amount: postStatement },
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

        const { entries } = computeSpendWrites(
          acct.balances.current   ?? 0,
          acct.balances.available ?? 0,
          acct.balances.limit     ?? 0,
          settings,
        );

        for (const { month, amount } of entries) {
          await client.execute({
            sql:  `INSERT INTO cc_variable_spend (month, card, amount, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
                   ON CONFLICT(month, card) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`,
            args: [month, mapping.card, amount],
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
