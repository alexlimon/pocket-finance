import { getClient } from './db';
import { getAccounts, getInstitutionName } from './plaid';

const CARD_MAP: { match: (n: string) => boolean; card: string }[] = [
  { match: (n) => n.includes('Ultimate Rewards') || n.includes('Sapphire'), card: 'sapphire' },
  { match: (n) => n.includes('Prime Visa'),                                 card: 'prime' },
];

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function syncCCSpend(env: CloudflareEnv): Promise<void> {
  const client = getClient(env);
  const month  = currentMonth();
  try {
    const items = await client.execute({ sql: 'SELECT id, access_token, institution_name FROM plaid_items', args: [] });
    for (const item of items.rows) {
      const accessToken = String(item.access_token);
      const accounts    = await getAccounts(accessToken, env);

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
        const used = Math.round(((acct.balances.limit ?? 0) - (acct.balances.available ?? 0)) * 100) / 100;
        await client.execute({
          sql:  `INSERT INTO cc_variable_spend (month, card, amount, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
                 ON CONFLICT(month, card) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`,
          args: [month, mapping.card, used],
        });
      }

      await client.execute({
        sql:  `UPDATE plaid_items SET last_synced = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
        args: [String(item.id)],
      });
    }
  } finally {
    client.close();
  }
}
