import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const client = getClient(env);
  try {
    const result = await client.execute('SELECT * FROM mortgage_accounts ORDER BY id');
    return json({ accounts: result.rows });
  } finally {
    client.close();
  }
}

export async function PUT(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const body = await context.request.json() as {
    id: string; name?: string;
    originalAmount?: number; startDate?: string;
    rate?: number; escrow?: number; extra?: number; extraStartDate?: string;
  };
  if (!body.id) return json({ error: 'id required' }, 400);

  const client = getClient(env);
  try {
    await client.execute({
      sql: `INSERT INTO mortgage_accounts (id, name, original_amount, start_date, rate, escrow, extra, extra_start_date, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            ON CONFLICT(id) DO UPDATE SET
              name             = excluded.name,
              original_amount  = excluded.original_amount,
              start_date       = excluded.start_date,
              rate             = excluded.rate,
              escrow           = excluded.escrow,
              extra            = excluded.extra,
              extra_start_date = excluded.extra_start_date,
              updated_at       = excluded.updated_at`,
      args: [
        body.id,
        body.name ?? body.id,
        body.originalAmount ?? 0,
        body.startDate ?? null,
        body.rate ?? 6.5,
        body.escrow ?? 0,
        body.extra ?? 0,
        body.extraStartDate ?? null,
      ],
    });
    return json({ ok: true });
  } finally {
    client.close();
  }
}
