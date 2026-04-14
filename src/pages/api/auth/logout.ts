import type { APIContext } from 'astro';
import { destroySession } from '../../../lib/auth';

export async function POST(context: APIContext): Promise<Response> {
  await destroySession(context.locals.runtime.env);
  return new Response(null, {
    status:  302,
    headers: {
      Location:   '/login',
      'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0',
    },
  });
}
