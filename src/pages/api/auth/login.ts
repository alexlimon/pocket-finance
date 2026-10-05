import type { APIContext } from 'astro';
import { hashPassword, hasPassword, createSession, safeNext } from '../../../lib/auth';
import { getClient } from '../../../lib/db';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;

  let password: string;
  let next = '/';
  try {
    const form = await context.request.formData();
    password   = String(form.get('password') ?? '').trim();
    next       = safeNext(String(form.get('next') ?? ''));
  } catch {
    return context.redirect('/login?error=1');
  }

  // Keep the destination through a failed attempt.
  const failed = next === '/' ? '/login?error=1' : `/login?error=1&next=${encodeURIComponent(next)}`;

  if (!password) return context.redirect(failed);

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

  if (!match) return context.redirect(failed);

  const cookieHeader = await createSession(env);
  return new Response(null, {
    status:  302,
    headers: { Location: next, 'Set-Cookie': cookieHeader },
  });
}
