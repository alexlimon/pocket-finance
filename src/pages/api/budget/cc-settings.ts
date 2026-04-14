import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';
import { computePaymentMonth } from './cc-charge';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);
  const client = getClient(env);
  try {
    const r = await client.execute(`SELECT * FROM cc_settings ORDER BY card`);
    return json({ settings: r.rows });
  } finally { client.close(); }
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: { card?: string; billing_end_day?: number; payment_day?: number };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { card, billing_end_day, payment_day } = body;
  if (!card) return json({ error: 'card required' }, 400);

  const client = getClient(env);
  try {
    if (billing_end_day != null) {
      await client.execute({ sql: `UPDATE cc_settings SET billing_end_day = ? WHERE card = ?`, args: [billing_end_day, card] });

      // Re-compute payment_month for all existing charges on this card that have a date
      const charges = await client.execute({
        sql: `SELECT id, date FROM cc_charges WHERE card = ? AND date IS NOT NULL`,
        args: [card],
      });
      for (const r of charges.rows) {
        const pm = computePaymentMonth(String(r.date), billing_end_day);
        await client.execute({ sql: `UPDATE cc_charges SET payment_month = ? WHERE id = ?`, args: [pm, r.id] });
      }
    }
    if (payment_day != null) {
      await client.execute({ sql: `UPDATE cc_settings SET payment_day = ? WHERE card = ?`, args: [payment_day, card] });
    }
    return json({ ok: true });
  } finally { client.close(); }
}
