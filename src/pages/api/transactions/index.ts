import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const sp       = context.url.searchParams;
  const entity   = sp.get('entity') ?? 'all';
  const month    = sp.get('month')  ?? new Date().toISOString().slice(0, 7);
  const limit    = Math.min(Number(sp.get('limit') ?? 200), 500);
  const offset   = Number(sp.get('offset') ?? 0);

  const args: unknown[] = [`${month}%`];
  let entityClause = '';
  if (entity !== 'all') { entityClause = 'AND t.entity_id = ?'; args.push(entity); }

  const client = getClient(env);
  try {
    const result = await client.execute({
      sql: `
        SELECT t.*, c.name as category_name
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.is_hidden = 0
          AND t.date LIKE ?
          ${entityClause}
        ORDER BY t.date DESC, t.created_at DESC
        LIMIT ? OFFSET ?
      `,
      args: [...args, limit, offset],
    });
    return json({ transactions: result.rows });
  } finally {
    client.close();
  }
}
