import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

// POST { month, bill_id, skip: true|false }
export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: { month?: string; bill_id?: string; skip?: boolean };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { month, bill_id, skip } = body;
  if (!month || !bill_id) return json({ error: 'month and bill_id required' }, 400);

  const id = `bp_${month}_${bill_id}`;
  const client = getClient(env);
  try {
    // Upsert a bill_payment row with is_skipped set; amount 0 + not paid when skipping
    await client.execute({
      sql: `INSERT INTO bill_payments (id, month, bill_id, amount, is_paid, is_cc, is_skipped)
            VALUES (?, ?, ?, 0, 0, 0, ?)
            ON CONFLICT(month, bill_id) DO UPDATE SET is_skipped = excluded.is_skipped`,
      args: [id, month, bill_id, skip ? 1 : 0],
    });
    return json({ ok: true });
  } finally { client.close(); }
}
