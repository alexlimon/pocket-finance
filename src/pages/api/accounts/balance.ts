import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let accountId: string, balance: number;
  try {
    const body = await context.request.json() as { accountId?: string; balance?: number };
    accountId  = String(body.accountId ?? '').trim();
    balance    = Number(body.balance);
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!accountId)        return json({ error: 'Missing accountId' }, 400);
  if (!isFinite(balance)) return json({ error: 'Invalid balance' }, 400);

  const client = getClient(env);
  try {
    await client.execute({
      sql:  `UPDATE accounts SET current_balance = ? WHERE id = ? AND type IN ('savings', 'investment')`,
      args: [balance, accountId],
    });
    return json({ ok: true });
  } finally {
    client.close();
  }
}
