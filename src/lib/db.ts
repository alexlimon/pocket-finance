import { createClient, type Client } from '@libsql/client/web';

export type Env = Pick<CloudflareEnv, 'TURSO_DATABASE_URL' | 'TURSO_AUTH_TOKEN'>;

/** Create a per-request Turso client. Always call client.close() in a finally block. */
export function getClient(env: Env): Client {
  return createClient({
    url:       env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
}

/** Consistent JSON response helper used across all API routes. */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
