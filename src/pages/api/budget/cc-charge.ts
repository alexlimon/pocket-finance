import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

/** Compute which month's CC payment a charge belongs to, given billing end day. */
export function computePaymentMonth(chargeDate: string, billingEndDay: number): string {
  const [yr, mo, dy] = chargeDate.split('-').map(Number);
  // If charge day <= billing end → closes this month's statement → paid NEXT month
  // If charge day >  billing end → closes NEXT month's statement → paid month after next
  const d = dy <= billingEndDay
    ? new Date(yr, mo, 1)       // mo is 1-indexed; new Date(yr, mo, 1) = first of next month
    : new Date(yr, mo + 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: { month?: string; description?: string; amount?: number; card?: string; is_big_purchase?: boolean; date?: string };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { month, description, amount, card = 'sapphire', is_big_purchase = false, date } = body;
  if (!month || !description || amount == null) return json({ error: 'month, description, amount required' }, 400);
  if (!['sapphire','prime','apple','other'].includes(card)) return json({ error: 'Invalid card' }, 400);

  const client = getClient(env);
  try {
    // Look up billing end day for this card
    const cfg = await client.execute({ sql: `SELECT billing_end_day FROM cc_settings WHERE card = ? LIMIT 1`, args: [card] });
    const billingEndDay = cfg.rows.length ? Number(cfg.rows[0].billing_end_day) : 18;

    const paymentMonth = date ? computePaymentMonth(date, billingEndDay) : null;
    const id = crypto.randomUUID();

    await client.execute({
      sql: `INSERT INTO cc_charges (id, month, date, description, amount, card, is_big_purchase, payment_month)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, month, date ?? null, description, amount, card, is_big_purchase ? 1 : 0, paymentMonth],
    });
    return json({ ok: true, id, payment_month: paymentMonth }, 201);
  } finally { client.close(); }
}

export async function PATCH(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: { id?: string; description?: string; amount?: number; card?: string; is_big_purchase?: boolean };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { id, ...fields } = body;
  if (!id) return json({ error: 'id required' }, 400);

  const allowed = new Set(['description','amount','card','is_big_purchase','date']);
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.has(k)) continue;
    sets.push(`${k} = ?`);
    args.push(k === 'is_big_purchase' ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return json({ error: 'Nothing to update' }, 400);

  const client = getClient(env);
  try {
    await client.execute({ sql: `UPDATE cc_charges SET ${sets.join(', ')} WHERE id = ?`, args: [...args, id] });
    return json({ ok: true });
  } finally { client.close(); }
}

export async function DELETE(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const id = context.url.searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);

  const client = getClient(env);
  try {
    await client.execute({ sql: 'DELETE FROM cc_charges WHERE id = ?', args: [id] });
    return json({ ok: true });
  } finally { client.close(); }
}
