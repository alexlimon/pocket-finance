import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const client = getClient(env);
  try {
    const result = await client.execute(
      'SELECT * FROM accounts WHERE is_active = 1 ORDER BY type, name',
    );
    return json({ accounts: result.rows });
  } finally {
    client.close();
  }
}
