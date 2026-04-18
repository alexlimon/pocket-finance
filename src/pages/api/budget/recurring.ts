import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

// GET — list all recurring budget_config items
export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);
  const client = getClient(env);
  try {
    const r = await client.execute(`
      SELECT bc.*, c.name as category_name
      FROM budget_config bc
      LEFT JOIN categories c ON bc.category_id = c.id
      WHERE bc.is_recurring = 1
      ORDER BY bc.is_cc_default ASC, bc.entity_id ASC, bc.due_day ASC NULLS LAST, bc.name ASC
    `);
    return json({ items: r.rows });
  } finally { client.close(); }
}

// POST — create a new recurring item
export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: {
    name?: string; amount?: number; due_day?: number; is_cc?: boolean;
    entity_id?: string; category_id?: string; start_month?: string; end_month?: string;
  };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { name, amount = 0, due_day, is_cc = false, entity_id = 'household',
          category_id, start_month, end_month } = body;
  if (!name?.trim()) return json({ error: 'name required' }, 400);

  const id = `bill_custom_${Date.now()}`;
  const client = getClient(env);
  try {
    await client.execute({
      sql: `INSERT INTO budget_config
              (id, name, monthly_target, due_day, is_recurring, is_cc_default, entity_id, category_id, start_month, end_month)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      args: [id, name.trim(), amount, due_day ?? null, is_cc ? 1 : 0,
             entity_id, category_id ?? null, start_month ?? null, end_month ?? null],
    });
    return json({ ok: true, id }, 201);
  } finally { client.close(); }
}

// PATCH — update a recurring item
export async function PATCH(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: Record<string, unknown>;
  try { body = await context.request.json() as Record<string, unknown>; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { id, ...fields } = body;
  if (!id) return json({ error: 'id required' }, 400);

  const allowed = new Set(['name','monthly_target','due_day','is_cc_default','entity_id','category_id','start_month','end_month']);
  const sets: string[] = []; const args: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.has(k)) continue;
    sets.push(`${k} = ?`); args.push(v as string | number | null);
  }
  if (!sets.length) return json({ error: 'Nothing to update' }, 400);

  const client = getClient(env);
  try {
    await client.execute({ sql: `UPDATE budget_config SET ${sets.join(', ')} WHERE id = ?`, args: [...args, id as string] });
    return json({ ok: true });
  } finally { client.close(); }
}

// DELETE — remove a recurring item and its payments
export async function DELETE(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const id = context.url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);

  const client = getClient(env);
  try {
    await client.execute({ sql: 'DELETE FROM bill_payments WHERE bill_id = ?', args: [id] });
    await client.execute({ sql: 'DELETE FROM budget_config WHERE id = ?', args: [id] });
    return json({ ok: true });
  } finally { client.close(); }
}
