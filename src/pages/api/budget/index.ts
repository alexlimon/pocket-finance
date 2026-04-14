import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const client = getClient(env);
  try {
    const result = await client.execute(`
      SELECT b.*, c.name as category_name
      FROM budget_config b
      LEFT JOIN categories c ON b.category_id = c.id
      ORDER BY b.entity_id, b.name
    `);
    return json({ budgets: result.rows });
  } finally {
    client.close();
  }
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: {
    name?: string;
    category_id?: string;
    monthly_target?: number;
    due_day?: number;
    is_recurring?: boolean;
    entity_id?: string;
    funding_account_id?: string;
  };

  try {
    body = await context.request.json() as typeof body;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.name?.trim()) return json({ error: 'name is required' }, 400);

  const id     = crypto.randomUUID();
  const client = getClient(env);
  try {
    await client.execute({
      sql: `
        INSERT INTO budget_config
          (id, name, category_id, monthly_target, due_day, is_recurring, entity_id, funding_account_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        body.name.trim(),
        body.category_id        ?? null,
        body.monthly_target     ?? null,
        body.due_day            ?? null,
        body.is_recurring ? 1 : 0,
        body.entity_id          ?? 'household',
        body.funding_account_id ?? null,
      ],
    });
    return json({ ok: true, id }, 201);
  } finally {
    client.close();
  }
}
