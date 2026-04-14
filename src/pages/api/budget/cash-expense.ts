import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: { month?: string; description?: string; amount?: number; date?: string; entity_id?: string; type?: string };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { month, description, amount, date, entity_id = 'household', type = 'expense' } = body;
  if (!month || !description || amount == null) return json({ error: 'month, description, amount required' }, 400);
  if (!['expense','income'].includes(type)) return json({ error: 'type must be expense or income' }, 400);

  const id = crypto.randomUUID();
  const client = getClient(env);
  try {
    await client.execute({
      sql: `INSERT INTO cash_expenses (id, month, date, description, amount, type, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, month, date ?? null, description, amount, type, entity_id],
    });
    return json({ ok: true, id }, 201);
  } finally { client.close(); }
}

export async function DELETE(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const id = context.url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);

  const client = getClient(env);
  try {
    await client.execute({ sql: 'DELETE FROM cash_expenses WHERE id = ?', args: [id] });
    return json({ ok: true });
  } finally { client.close(); }
}
