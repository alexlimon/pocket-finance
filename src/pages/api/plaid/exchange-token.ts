import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';
import { exchangePublicToken, getInstitutionName } from '../../../lib/plaid';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let publicToken: string;
  try {
    const body  = await context.request.json() as { public_token?: string };
    publicToken = String(body.public_token ?? '').trim();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!publicToken) return json({ error: 'Missing public_token' }, 400);

  try {
    const { access_token, item_id } = await exchangePublicToken(publicToken, env);
    const institutionName = await getInstitutionName(access_token, env).catch(() => 'Unknown Bank');

    const client = getClient(env);
    try {
      await client.execute({
        sql:  `INSERT OR REPLACE INTO plaid_items (id, access_token, institution_name) VALUES (?, ?, ?)`,
        args: [item_id, access_token, institutionName],
      });
    } finally {
      client.close();
    }

    return json({ ok: true, item_id });
  } catch (err) {
    console.error('Plaid exchange-token error:', err);
    return json({ error: 'Failed to connect bank account' }, 500);
  }
}
