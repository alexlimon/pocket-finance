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

  const key = `cc_paid_${card}_${month}`;
  const client = getClient(env);
  try {
    if (paid) {
      await client.execute({
        sql:  `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
        args: [key, new Date().toISOString()],
      });
    } else {
      await client.execute({ sql: `DELETE FROM settings WHERE key = ?`, args: [key] });
    }
    await syncCCSpend(env);
    return json({ ok: true });
  } finally { client.close(); }
}
