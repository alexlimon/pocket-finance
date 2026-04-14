import type { APIContext } from 'astro';
import { verifySession } from '../../../lib/auth';
import { json } from '../../../lib/db';
import { createLinkToken } from '../../../lib/plaid';

export async function POST(context: APIContext): Promise<Response> {
  const env = context.locals.runtime.env;
  if (!(await verifySession(context.request, env))) return json({ error: 'Unauthorized' }, 401);

  // Client sends its own origin so the redirect_uri works for both
  // localhost dev and the production domain without hardcoding.
  let redirectUri: string | undefined;
  try {
    const body = await context.request.json() as { redirectUri?: string };
    if (body.redirectUri) redirectUri = body.redirectUri;
  } catch { /* body is optional */ }

  try {
    const { link_token } = await createLinkToken(env, redirectUri);
    return json({ link_token });
  } catch (err) {
    console.error('Plaid link-token error:', err);
    return json({ error: String(err) }, 500);
  }
}
