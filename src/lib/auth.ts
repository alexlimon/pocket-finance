import { getClient, type Env } from './db';

const SESSION_KEY   = 'session';
const PASSWORD_KEY  = 'password_hash';
const SESSION_BYTES = 32; // 64-char hex token

/** Parse a single cookie by name from the Cookie header. */
export function getCookie(header: string, name: string): string | null {
  const match = header.match(new RegExp(`(?:^|;)\\s*${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Generate a cryptographically random hex token. */
export function randomToken(bytes = SESSION_BYTES): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hash of a password string (hex output). */
export async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

/** True if a household password has been configured in DB. */
export async function hasPassword(env: Env): Promise<boolean> {
  const client = getClient(env);
  try {
    const result = await client.execute({
      sql:  `SELECT value FROM settings WHERE key = ? LIMIT 1`,
      args: [PASSWORD_KEY],
    });
    return result.rows.length > 0 && Boolean(result.rows[0].value);
  } finally {
    client.close();
  }
}

/** Verify the session cookie against the DB-stored session token.
 *  Returns true when valid, false otherwise. */
export async function verifySession(request: Request, env: Env): Promise<boolean> {
  const cookieHeader = request.headers.get('Cookie') ?? '';
  const token = getCookie(cookieHeader, SESSION_KEY);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;

  const client = getClient(env);
  try {
    const result = await client.execute({
      sql:  `SELECT value FROM settings WHERE key = ? LIMIT 1`,
      args: [SESSION_KEY],
    });
    return result.rows.length > 0 && String(result.rows[0].value) === token;
  } finally {
    client.close();
  }
}

/** Create a new session in DB and return the Set-Cookie header value. */
export async function createSession(env: Env): Promise<string> {
  const token  = randomToken();
  const client = getClient(env);
  try {
    await client.execute({
      sql:  `INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)`,
      args: [SESSION_KEY, token],
    });
  } finally {
    client.close();
  }
  return `session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=2592000`; // 30 days
}

/** Destroy the current session in DB. */
export async function destroySession(env: Env): Promise<void> {
  const client = getClient(env);
  try {
    await client.execute({
      sql:  `DELETE FROM settings WHERE key = ?`,
      args: [SESSION_KEY],
    });
  } finally {
    client.close();
  }
}
