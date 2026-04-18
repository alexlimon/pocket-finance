import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const client = getClient(env);
  try {
    const result = await client.execute(
      `SELECT id, account_last4, account_source, date, post_date,
              description, category, type, amount, memo, uploaded_at
       FROM csv_transactions
       ORDER BY date DESC`
    );
    return json(result.rows);
  } finally {
    client.close();
  }
}

export async function DELETE(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const account = new URL(context.request.url).searchParams.get('account');
  const client = getClient(env);
  try {
    if (account) {
      await client.execute({ sql: `DELETE FROM csv_transactions WHERE account_last4 = ?`, args: [account] });
    } else {
      await client.execute(`DELETE FROM csv_transactions`);
    }
    return json({ ok: true });
  } finally {
    client.close();
  }
}
