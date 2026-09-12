import type { APIContext } from 'astro';
import { verifySession, verifyApiKey } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';
import { reconcileCCBudgets, type CardSettings } from '../../../lib/reconcile';

const VALID_CARDS = new Set(['sapphire','prime','apple','other']);

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  const authed = (await verifySession(context.request, env)) || (await verifyApiKey(context.request, env));
  if (!authed) return json({ error: 'Unauthorized' }, 401);

  let body: { month?: string; card?: string; amount?: number };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { month, card, amount } = body;
  if (!month || !card || amount == null) return json({ error: 'month, card, amount required' }, 400);
  if (!VALID_CARDS.has(card)) return json({ error: 'Invalid card' }, 400);
  if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: 'Invalid month' }, 400);

  const client = getClient(env);
  try {
    const settingsRes = await client.execute({ sql: 'SELECT card, billing_end_day, payment_day FROM cc_settings', args: [] });
    const settingsMap = new Map<string, CardSettings>(
      settingsRes.rows.map(r => [
        String(r.card),
        { billing_end_day: Number(r.billing_end_day), payment_day: Number(r.payment_day) },
      ]),
    );

    await client.execute({
      sql: `INSERT INTO cc_variable_spend (month, card, amount) VALUES (?, ?, ?)
            ON CONFLICT(month, card) DO UPDATE SET amount = excluded.amount`,
      args: [month, card, amount],
    });

    // A manual edit of a CLOSED billing month pins the row: statement_balance
    // snapshots the corrected amount so the Plaid reconciler never overwrites it.
    const s = settingsMap.get(card);
    if (s) {
      const [y, m] = month.split('-').map(Number);
      if (new Date() >= new Date(y, m - 1, s.billing_end_day)) {
        await client.execute({
          sql:  `UPDATE cc_variable_spend SET statement_balance = COALESCE(statement_balance, ?) WHERE month = ? AND card = ?`,
          args: [amount, month, card],
        });
      }
    }

    // Publish the (possibly corrected) statement total into the payment month's
    // cc_budget unless that month is latched, and keep its balance chain current.
    await reconcileCCBudgets(client, settingsMap);

    return json({ ok: true });
  } finally { client.close(); }
}
