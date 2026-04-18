import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';
import { nextMonth } from '../../../lib/budget';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: Record<string, unknown>;
  try { body = await context.request.json() as Record<string, unknown>; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const month = String(body.month ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: 'Invalid month' }, 400);

  const allowed = new Set([
    'income_alex','income_maham','income_other',
    'checking_before','checking_after','savings_before','savings_after',
    'cc_budget','notes',
  ]);

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (k === 'month' || !allowed.has(k)) continue;
    sets.push(`${k} = ?`);
    args.push(v as string | number | null);
  }
  if (!sets.length) return json({ error: 'Nothing to update' }, 400);

  const client = getClient(env);
  try {
    // Upsert: create the row if it doesn't exist yet
    await client.execute({
      sql:  `INSERT INTO monthly_summary (month) VALUES (?) ON CONFLICT(month) DO NOTHING`,
      args: [month],
    });
    await client.execute({
      sql:  `UPDATE monthly_summary SET ${sets.join(', ')} WHERE month = ?`,
      args: [...args, month],
    });

    // When checking_after is saved, propagate it as the next month's checking_before
    if ('checking_after' in body) {
      const next = nextMonth(month);
      await client.execute({
        sql:  `INSERT INTO monthly_summary (month) VALUES (?) ON CONFLICT(month) DO NOTHING`,
        args: [next],
      });
      await client.execute({
        sql:  `UPDATE monthly_summary SET checking_before = ? WHERE month = ?`,
        args: [Number(body.checking_after), next],
      });
    }

    return json({ ok: true });
  } finally { client.close(); }
}
