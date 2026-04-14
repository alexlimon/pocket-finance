import type { APIContext } from 'astro';
import { hashPassword, hasPassword, createSession } from '../../../lib/auth';
import { getClient } from '../../../lib/db';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;

  // Only allowed if no password is set yet
  if (await hasPassword(env)) {
    return new Response(null, { status: 302, headers: { Location: '/login' } });
  }

  let password: string, confirm: string;
  try {
    const form = await context.request.formData();
    password   = String(form.get('password') ?? '').trim();
    confirm    = String(form.get('confirm')  ?? '').trim();
  } catch {
    return new Response(null, { status: 302, headers: { Location: '/setup?error=invalid' } });
  }

  if (!password || password.length < 8) {
    return new Response(null, { status: 302, headers: { Location: '/setup?error=short' } });
  }

  if (password !== confirm) {
    return new Response(null, { status: 302, headers: { Location: '/setup?error=mismatch' } });
  }

  const hash   = await hashPassword(password);
  const client = getClient(env);
  try {
    await client.execute({
      sql:  `INSERT OR REPLACE INTO settings(key, value) VALUES('password_hash', ?)`,
      args: [hash],
    });
  } finally {
    client.close();
  }

  const cookieHeader = await createSession(env);
  return new Response(null, {
    status:  302,
    headers: { Location: '/connect', 'Set-Cookie': cookieHeader },
  });
}
