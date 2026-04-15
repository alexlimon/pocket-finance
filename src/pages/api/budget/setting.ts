import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { getClient, json } from '../../../lib/db';

// GET  ?key=foo            → { value: string | null }
// POST { key, value }      → { ok: true }
export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  const key = context.url.searchParams.get('key');
  if (!key) return json({ error: 'key required' }, 400);

  const client = getClient(env);
  try {
    const r = await client.execute({ sql: 'SELECT value FROM settings WHERE key = ? LIMIT 1', args: [key] });
    return json({ value: r.rows[0] ? String((r.rows[0] as any).value) : null });
  } finally { client.close(); }
}

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  let body: { key?: string; value?: string };
  try { body = await context.request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { key, value } = body;
  if (!key || value === undefined) return json({ error: 'key and value required' }, 400);

  const client = getClient(env);
  try {
    await client.execute({
      sql:  `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [key, value],
    });
    return json({ ok: true });
  } finally { client.close(); }
}
