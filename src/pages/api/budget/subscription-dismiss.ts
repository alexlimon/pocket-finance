import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

// GET — list all dismissed subscription keys { vendor_alias, account_last4 }
export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const client = getClient(env);
  try {
    const r = await client.execute(
      `SELECT vendor_alias, account_last4 FROM subscription_dismissals ORDER BY vendor_alias ASC`
    );
    return json(r.rows);
  } finally {
    client.close();
  }
}

// POST { vendor_alias, account_last4 } — hide a detected vendor
export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: { vendor_alias?: string; account_last4?: string };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const alias = body.vendor_alias?.trim();
  const account = body.account_last4?.trim();
  if (!alias || !account) return json({ error: 'vendor_alias and account_last4 required' }, 400);

  const client = getClient(env);
  try {
    await client.execute({
      sql: `INSERT OR REPLACE INTO subscription_dismissals (vendor_alias, account_last4, dismissed_at)
            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`,
      args: [alias, account],
    });
    return json({ ok: true });
  } finally {
    client.close();
  }
}

// DELETE ?vendor_alias=…&account=… — unhide a dismissed vendor
export async function DELETE(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const params = new URL(context.request.url).searchParams;
  const alias = params.get('vendor_alias')?.trim();
  const account = params.get('account')?.trim();
  if (!alias || !account) return json({ error: 'vendor_alias and account required' }, 400);

  const client = getClient(env);
  try {
    await client.execute({
      sql: `DELETE FROM subscription_dismissals WHERE vendor_alias = ? AND account_last4 = ?`,
      args: [alias, account],
    });
    return json({ ok: true });
  } finally {
    client.close();
  }
}
