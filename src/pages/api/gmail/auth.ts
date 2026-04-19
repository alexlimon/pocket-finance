import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { gmailAuthUrl } from '../../../lib/gmail';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) {
    return new Response(null, { status: 401 });
  }

  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return new Response('GOOGLE_CLIENT_ID not configured', { status: 500 });
  }

  const origin      = new URL(context.request.url).origin;
  const redirectUri = `${origin}/api/gmail/callback`;
  const authUrl     = gmailAuthUrl(clientId, redirectUri);

  return new Response(null, { status: 302, headers: { Location: authUrl } });
}
