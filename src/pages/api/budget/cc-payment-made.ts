import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';
import { syncCCSpend } from '../../../lib/plaid-sync';

/**
 * POST { card, month, paid: true|false }
 *
 * Marks a card's statement as already paid — the remaining balance stops being
 * subtracted from the current cycle's spend tracker.
 *
 * `month` is the BILLING month whose statement was settled — for the Credit Card
 * Payment row shown on month M, that is M-1.
 *
 * `card` may be a single card or 'all'. The payment clears every card's statement
 * for that billing month, so the budget page sends 'all'.
 *
 * `paid: true`  → writes marker `cc_paid_<card>_<month>` (timestamp value),
 *                 then runs syncCCSpend so the split updates immediately.
 * `paid: false` → deletes the marker (undo), then re-syncs.
 */
export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: { card?: string; month?: string; paid?: boolean };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { card, month, paid } = body;
  if (!card || !month) return json({ error: 'card and month required' }, 400);
  if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: 'Invalid month' }, 400);
  if (!/^[a-z0-9_]+$/.test(card)) return json({ error: 'Invalid card' }, 400);

  const client = getClient(env);
  try {
    let cards = [card];
    if (card === 'all') {
      const res = await client.execute({ sql: 'SELECT card FROM cc_settings', args: [] });
      cards = res.rows.map(r => String(r.card));
      if (!cards.length) return json({ error: 'No cards configured' }, 400);
    }

    const now = new Date().toISOString();
    await client.batch(cards.map(c => paid
      ? { sql: `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, args: [`cc_paid_${c}_${month}`, now] }
      : { sql: `DELETE FROM settings WHERE key = ?`,                        args: [`cc_paid_${c}_${month}`] }
    ));

    await syncCCSpend(env);
    return json({ ok: true, cards: cards.length });
  } finally { client.close(); }
}
