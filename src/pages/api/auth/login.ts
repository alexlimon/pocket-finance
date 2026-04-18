import type { APIContext } from 'astro';
import { hashPassword, hasPassword, createSession } from '../../../lib/auth';
import { getClient } from '../../../lib/db';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;

  let password: string;
  try {
    const form = await context.request.formData();
    password   = String(form.get('password') ?? '').trim();
  } catch {
    return context.redirect('/login?error=1');
  }

  if (!password) return context.redirect('/login?error=1');

  if (!(await hasPassword(env))) return context.redirect('/setup');

  const hash   = await hashPassword(password);
  const client = getClient(env);
  let match    = false;
  try {
    const result = await client.execute({
      sql:  `SELECT value FROM settings WHERE key = 'password_hash' LIMIT 1`,
      args: [],
    });
    match = result.rows.length > 0 && String(result.rows[0].value) === hash;
  } finally {
    client.close();
  }

  if (!match) return context.redirect('/login?error=1');

  const cookieHeader = await createSession(env);
  return new Response(null, {
    status:  302,
    headers: { Location: '/', 'Set-Cookie': cookieHeader },
  });
}
