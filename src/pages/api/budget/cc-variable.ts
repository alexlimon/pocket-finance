import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

const VALID_CARDS = new Set(['sapphire','prime','apple','other']);

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: { month?: string; card?: string; amount?: number };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { month, card, amount } = body;
  if (!month || !card || amount == null) return json({ error: 'month, card, amount required' }, 400);
  if (!VALID_CARDS.has(card)) return json({ error: 'Invalid card' }, 400);

  const client = getClient(env);
  try {
    await client.execute({
      sql: `INSERT INTO cc_variable_spend (month, card, amount) VALUES (?, ?, ?)
            ON CONFLICT(month, card) DO UPDATE SET amount = excluded.amount`,
      args: [month, card, amount],
    });
    return json({ ok: true });
  } finally { client.close(); }
}
