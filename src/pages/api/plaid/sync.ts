import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';
import { syncTransactions, getAccounts, type PlaidTransaction } from '../../../lib/plaid';

/** Normalize a merchant name using the merchant_rules table. */
async function normalizeMerchant(
  raw: string,
  plaidName: string | null,
  rules: { pattern: string; merchant_clean: string; category_id: string | null; entity_id: string | null }[],
): Promise<{ merchantClean: string; categoryId: string | null; entityId: string | null }> {
  const base = plaidName ?? raw;

  for (const rule of rules.sort((a, b) => (b as any).priority - (a as any).priority)) {
    if (base.toLowerCase().includes(rule.pattern.toLowerCase())) {
      return {
        merchantClean: rule.merchant_clean,
        categoryId:    rule.category_id ?? null,
        entityId:      rule.entity_id ?? null,
      };
    }
  }

  return { merchantClean: base, categoryId: null, entityId: null };
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  // Optional: sync a specific item, or sync all items
  let itemId: string | null = null;
  try {
    const form = await context.request.formData();
    itemId = form.get('item_id') ? String(form.get('item_id')) : null;
  } catch {
    try {
      const body = await context.request.json() as { item_id?: string };
      itemId = body.item_id ?? null;
    } catch { /* no body */ }
  }

  const client = getClient(env);
  let stats = { added: 0, modified: 0, removed: 0, accounts: 0 };

  try {
    // Fetch Plaid items to sync
    const itemRes = await client.execute(
      itemId
        ? { sql: 'SELECT * FROM plaid_items WHERE id = ?', args: [itemId] }
        : { sql: 'SELECT * FROM plaid_items', args: [] },
    );

    const rules = (await client.execute('SELECT * FROM merchant_rules')).rows as unknown as {
      pattern: string; merchant_clean: string; category_id: string | null;
      entity_id: string | null; priority: number;
    }[];

    for (const item of itemRes.rows) {
      const accessToken = String(item.access_token);
      const cursor      = item.cursor ? String(item.cursor) : null;
      const id          = String(item.id);

      // Sync balances
      try {
        const plaidAccounts = await getAccounts(accessToken, env);
        for (const acct of plaidAccounts) {
          await client.execute({
            sql: `
              UPDATE accounts
              SET current_balance   = ?,
                  available_balance = ?,
                  last_synced       = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              WHERE id = ?
            `,
            args: [acct.balances.current ?? 0, acct.balances.available ?? null, acct.account_id],
          });
        }
        stats.accounts += plaidAccounts.length;
      } catch (err) {
        console.error(`Balance sync failed for item ${id}:`, err);
      }

      // Sync transactions
      try {
        const { added, modified, removed, nextCursor } = await syncTransactions(accessToken, cursor, env);

        // Process added transactions
        for (const t of added) {
          const { merchantClean, categoryId, entityId } = await normalizeMerchant(
            t.name, t.merchant_name, rules,
          );

          // Determine entity from account
          const acctRes = await client.execute({
            sql:  'SELECT entity_id FROM accounts WHERE id = ? LIMIT 1',
            args: [t.account_id],
          });
          const acctEntity = acctRes.rows.length > 0 ? String(acctRes.rows[0].entity_id) : 'household';
          const finalEntity = entityId ?? acctEntity;

          await client.execute({
            sql: `
              INSERT OR IGNORE INTO transactions
                (id, account_id, date, authorized_date, amount,
                 merchant_raw, merchant_clean, category_id, entity_id, is_pending)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            args: [
              t.transaction_id,
              t.account_id,
              t.date,
              t.authorized_date ?? null,
              t.amount,
              t.name,
              merchantClean,
              categoryId,
              finalEntity,
              t.pending ? 1 : 0,
            ],
          });
          stats.added++;
        }

        // Process modified transactions
        for (const t of modified) {
          const { merchantClean, categoryId } = await normalizeMerchant(
            t.name, t.merchant_name, rules,
          );
          await client.execute({
            sql: `
              UPDATE transactions
              SET date           = ?,
                  amount         = ?,
                  merchant_raw   = ?,
                  merchant_clean = ?,
                  category_id    = COALESCE(category_id, ?),
                  is_pending     = ?,
                  updated_at     = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              WHERE id = ?
            `,
            args: [
              t.date, t.amount, t.name, merchantClean,
              categoryId, t.pending ? 1 : 0, t.transaction_id,
            ],
          });
          stats.modified++;
        }

        // Process removed transactions
        for (const txnId of removed) {
          await client.execute({
            sql:  'UPDATE transactions SET is_hidden = 1 WHERE id = ?',
            args: [txnId],
          });
          stats.removed++;
        }

        // Update cursor and last_synced
        await client.execute({
          sql:  `UPDATE plaid_items SET cursor = ?, last_synced = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
          args: [nextCursor, id],
        });
      } catch (err) {
        console.error(`Transaction sync failed for item ${id}:`, err);
      }
    }
  } finally {
    client.close();
  }

  // Redirect back to connect page if called from a form, else return JSON
  const accept = context.request.headers.get('Accept') ?? '';
  if (accept.includes('text/html')) {
    return new Response(null, { status: 302, headers: { Location: '/connect' } });
  }
  return json({ ok: true, stats });
}
