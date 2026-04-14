import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';
import { exchangePublicToken, getAccounts, getItem, getInstitutionName } from '../../../lib/plaid';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let publicToken: string;
  try {
    const body   = await context.request.json() as { public_token?: string };
    publicToken  = String(body.public_token ?? '').trim();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!publicToken) return json({ error: 'Missing public_token' }, 400);

  try {
    // Exchange public token for access token
    const { access_token, item_id } = await exchangePublicToken(publicToken, env);

    // Get institution info
    const item = await getItem(access_token, env);
    let institutionName = 'Unknown Bank';
    if (item.institution_id) {
      try { institutionName = await getInstitutionName(item.institution_id, env); }
      catch { /* non-critical */ }
    }

    // Fetch accounts
    const plaidAccounts = await getAccounts(access_token, env);

    const client = getClient(env);
    try {
      // Store the Plaid item
      await client.execute({
        sql: `
          INSERT OR REPLACE INTO plaid_items
            (id, access_token, institution_id, institution_name)
          VALUES (?, ?, ?, ?)
        `,
        args: [item_id, access_token, item.institution_id ?? null, institutionName],
      });

      // Upsert accounts
      for (const acct of plaidAccounts) {
        await client.execute({
          sql: `
            INSERT INTO accounts
              (id, plaid_item_id, name, official_name, type, subtype, current_balance, available_balance)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name              = excluded.name,
              official_name     = excluded.official_name,
              type              = excluded.type,
              subtype           = excluded.subtype,
              current_balance   = excluded.current_balance,
              available_balance = excluded.available_balance,
              last_synced       = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          `,
          args: [
            acct.account_id,
            item_id,
            acct.name,
            acct.official_name ?? null,
            acct.type,
            acct.subtype ?? null,
            acct.balances.current  ?? 0,
            acct.balances.available ?? null,
          ],
        });
      }
    } finally {
      client.close();
    }

    return json({ ok: true, item_id, accounts: plaidAccounts.length });
  } catch (err) {
    console.error('Plaid exchange-token error:', err);
    return json({ error: 'Failed to connect bank account' }, 500);
  }
}
