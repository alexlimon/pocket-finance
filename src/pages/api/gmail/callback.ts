import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { exchangeCode, saveTokens } from '../../../lib/gmail';

export async function GET(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) {
    return new Response(null, { status: 302, headers: { Location: '/login' } });
  }

  const url   = new URL(context.request.url);
  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    return new Response(null, { status: 302, headers: { Location: '/analyze?gmail_error=1' } });
  }

  const clientId     = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new Response('Google credentials not configured', { status: 500 });
  }

  const redirectUri = `${url.origin}/api/gmail/callback`;

  try {
    const tokens = await exchangeCode(code, clientId, clientSecret, redirectUri);
    await saveTokens(env, tokens);
    return new Response(null, { status: 302, headers: { Location: '/analyze?gmail_connected=1' } });
  } catch {
    return new Response(null, { status: 302, headers: { Location: '/analyze?gmail_error=1' } });
  }
}
