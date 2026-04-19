import { getClient, type Env } from './db';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GmailTokens {
  access_token:  string;
  refresh_token: string;
  expiry_ms:     number; // unix ms
}

export interface ParsedAmazonEmail {
  orderId:     string;
  grandTotal:  number;
  items:       { name: string; qty: number }[];
  emailDate:   string; // YYYY-MM-DD
  subject:     string;
}

export interface GmailStatus {
  connected:    boolean;
  lastSync:     string | null;
  ordersCount:  number;
  matchedCount: number;
}

// ── Settings keys ─────────────────────────────────────────────────────────────

const KEY_ACCESS  = 'gmail_access_token';
const KEY_REFRESH = 'gmail_refresh_token';
const KEY_EXPIRY  = 'gmail_token_expiry';
const KEY_SYNC    = 'gmail_last_sync';

// ── Token persistence ─────────────────────────────────────────────────────────

export async function loadTokens(env: Env): Promise<GmailTokens | null> {
  const client = getClient(env);
  try {
    // Three separate reads — libSQL doesn't accept array args for IN clauses
    const [a, r, e] = await Promise.all([
      client.execute({ sql: `SELECT value FROM settings WHERE key = ?`, args: [KEY_ACCESS]  }),
      client.execute({ sql: `SELECT value FROM settings WHERE key = ?`, args: [KEY_REFRESH] }),
      client.execute({ sql: `SELECT value FROM settings WHERE key = ?`, args: [KEY_EXPIRY]  }),
    ]);
    const access  = a.rows[0]?.value as string | undefined;
    const refresh = r.rows[0]?.value as string | undefined;
    const expiry  = e.rows[0]?.value as string | undefined;
    if (!access || !refresh || !expiry) return null;
    return { access_token: access, refresh_token: refresh, expiry_ms: Number(expiry) };
  } finally {
    client.close();
  }
}

export async function saveTokens(env: Env, tokens: GmailTokens): Promise<void> {
  const client = getClient(env);
  try {
    await Promise.all([
      client.execute({ sql: `INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`, args: [KEY_ACCESS,  tokens.access_token]          }),
      client.execute({ sql: `INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`, args: [KEY_REFRESH, tokens.refresh_token]         }),
      client.execute({ sql: `INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`, args: [KEY_EXPIRY,  String(tokens.expiry_ms)]     }),
    ]);
  } finally {
    client.close();
  }
}

export async function clearTokens(env: Env): Promise<void> {
  const client = getClient(env);
  try {
    await client.execute({ sql: `DELETE FROM settings WHERE key IN (?, ?, ?)`, args: [KEY_ACCESS, KEY_REFRESH, KEY_EXPIRY] });
  } finally {
    client.close();
  }
}

export async function saveLastSync(env: Env): Promise<void> {
  const client = getClient(env);
  try {
    await client.execute({ sql: `INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`, args: [KEY_SYNC, new Date().toISOString()] });
  } finally {
    client.close();
  }
}

// ── OAuth helpers ─────────────────────────────────────────────────────────────

export function gmailAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/gmail.readonly',
    access_type:   'offline',
    prompt:        'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<GmailTokens> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expiry_ms:     Date.now() + data.expires_in * 1000,
  };
}

async function refreshAccessToken(tokens: GmailTokens, clientId: string, clientSecret: string): Promise<GmailTokens> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ refresh_token: tokens.refresh_token, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  return { ...tokens, access_token: data.access_token, expiry_ms: Date.now() + data.expires_in * 1000 };
}

export async function getValidToken(env: Env, clientId: string, clientSecret: string): Promise<string | null> {
  const tokens = await loadTokens(env);
  if (!tokens) return null;
  if (Date.now() < tokens.expiry_ms - 60_000) return tokens.access_token;
  const refreshed = await refreshAccessToken(tokens, clientId, clientSecret);
  await saveTokens(env, refreshed);
  return refreshed.access_token;
}

// ── Gmail REST API ────────────────────────────────────────────────────────────

interface GmailMessageHeader { name: string; value: string }
interface GmailPart { mimeType: string; body: { data?: string }; parts?: GmailPart[] }
interface GmailMessage {
  id: string;
  payload: { headers: GmailMessageHeader[]; body: { data?: string }; parts?: GmailPart[] };
}

export async function listMessageIds(accessToken: string, query: string, maxResults = 200): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(maxResults - ids.length, 100)) });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) break;
    const data = await res.json() as { messages?: { id: string }[]; nextPageToken?: string };
    if (data.messages) ids.push(...data.messages.map(m => m.id));
    pageToken = ids.length < maxResults ? data.nextPageToken : undefined;
  } while (pageToken);

  return ids;
}

export async function fetchMessage(accessToken: string, id: string): Promise<GmailMessage | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return null;
  return res.json() as Promise<GmailMessage>;
}

// ── Body decoding ─────────────────────────────────────────────────────────────

function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function extractBody(payload: GmailMessage['payload']): string {
  // Prefer text/plain, fallback to text/html
  function search(parts: GmailPart[] | undefined, preferred: string): string | null {
    if (!parts) return null;
    for (const p of parts) {
      if (p.mimeType === preferred && p.body.data) return decodeBase64Url(p.body.data);
      const nested = search(p.parts, preferred);
      if (nested) return nested;
    }
    return null;
  }
  if (payload.body.data) return decodeBase64Url(payload.body.data);
  return search(payload.parts, 'text/plain')
    ?? search(payload.parts, 'text/html')
    ?? '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Amazon email parser ───────────────────────────────────────────────────────

export function parseAmazonEmail(msg: GmailMessage): ParsedAmazonEmail | null {
  const headers = msg.payload.headers;
  const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value ?? '';
  const dateHdr = headers.find(h => h.name.toLowerCase() === 'date')?.value ?? '';

  const rawBody  = extractBody(msg.payload);
  const textBody = rawBody.includes('<') ? stripHtml(rawBody) : rawBody;

  // Order number
  const orderMatch = textBody.match(/(\d{3}-\d{7}-\d{7})/);
  if (!orderMatch) return null;
  const orderId = orderMatch[1]!;

  // Grand total — try several label patterns
  const totalPatterns = [
    /Grand\s+Total[^$\d]{0,60}\$([\d,]+\.\d{2})/i,
    /Order\s+Total[^$\d]{0,60}\$([\d,]+\.\d{2})/i,
    /Charged\s+to[^$\d]{0,120}\$([\d,]+\.\d{2})/i,
    /Total\s+for\s+this\s+shipment[^$\d]{0,60}\$([\d,]+\.\d{2})/i,
    /Total[^$\d]{0,40}\$([\d,]+\.\d{2})/i,
  ];
  let grandTotal: number | null = null;
  for (const pat of totalPatterns) {
    const m = textBody.match(pat);
    if (m) { grandTotal = parseFloat(m[1]!.replace(/,/g, '')); break; }
  }
  if (!grandTotal) return null;

  // Email date from header
  const emailDate = dateHdr ? new Date(dateHdr).toISOString().slice(0, 10) : '';
  if (!emailDate || emailDate === 'Invalid') return null;

  // Items — best-effort extraction between order # and total block
  const items = extractItems(textBody, orderId);

  return { orderId, grandTotal, items, emailDate, subject };
}

function extractItems(text: string, orderId: string): { name: string; qty: number }[] {
  // Grab text window after the order number
  const orderIdx = text.indexOf(orderId);
  const window = orderIdx >= 0 ? text.slice(orderIdx, orderIdx + 2000) : text.slice(0, 2000);

  const items: { name: string; qty: number }[] = [];

  // Pattern: "Qty: N" preceded or followed by product text
  const qtyMatches = [...window.matchAll(/(?:Qty|Quantity)[:\s]+(\d+)/gi)];
  for (const m of qtyMatches) {
    const qty = parseInt(m[1]!, 10);
    // Grab up to 120 chars before the "Qty:" as potential product name
    const before = window.slice(Math.max(0, m.index! - 120), m.index!).trim();
    const lines = before.split(/\s{3,}|\n/).filter(l => l.trim().length > 5);
    const name = lines[lines.length - 1]?.trim().slice(0, 80) ?? '';
    if (name) items.push({ name, qty });
  }

  // Fallback: if no qty matches, try to grab product-looking lines
  if (!items.length) {
    const lines = window.split(/\s{3,}|\n/)
      .map(l => l.trim())
      .filter(l => l.length > 15 && l.length < 100 && !/^\$|total|order|ship|deliver|thank|track/i.test(l));
    for (const line of lines.slice(0, 5)) {
      items.push({ name: line, qty: 1 });
    }
  }

  return items.slice(0, 10);
}

// ── Matching ──────────────────────────────────────────────────────────────────

export interface MatchResult {
  txnId:   string;
  orderId: string;
}

export function matchOrdersToTransactions(
  orders: { order_id: string; email_date: string; grand_total: number }[],
  txns:   { id: string; date: string; amount: number }[],
): MatchResult[] {
  const results: MatchResult[] = [];
  const usedTxns = new Set<string>();

  const inWindow = (txnDate: string, orderDate: number, days: number) =>
    Math.abs(new Date(txnDate).getTime() - orderDate) / 86_400_000 <= days;

  for (const order of orders) {
    const orderDate = new Date(order.email_date).getTime();

    // 1. Exact amount match within ±3 days
    const exact = txns.find(t =>
      !usedTxns.has(t.id) &&
      Math.abs(Math.abs(t.amount) - order.grand_total) < 0.02 &&
      inWindow(t.date, orderDate, 3)
    );
    if (exact) {
      usedTxns.add(exact.id);
      results.push({ txnId: exact.id, orderId: order.order_id });
      continue;
    }

    // 2. Half-amount match — order split into 2 equal shipments on separate charges
    //    Find up to 2 transactions each equal to grand_total / 2 within ±5 days
    const half = order.grand_total / 2;
    if (half >= 0.50) {
      const halfMatches = txns.filter(t =>
        !usedTxns.has(t.id) &&
        Math.abs(Math.abs(t.amount) - half) < 0.02 &&
        inWindow(t.date, orderDate, 5)
      ).slice(0, 2);
      for (const m of halfMatches) {
        usedTxns.add(m.id);
        results.push({ txnId: m.id, orderId: order.order_id });
      }
    }
  }

  return results;
}

// ── Status query ──────────────────────────────────────────────────────────────

export async function getGmailStatus(env: Env): Promise<GmailStatus> {
  const client = getClient(env);
  try {
    const [tokenRow, syncRow, ordersRow, matchesRow] = await Promise.all([
      client.execute({ sql: `SELECT value FROM settings WHERE key = ?`, args: [KEY_ACCESS]  }),
      client.execute({ sql: `SELECT value FROM settings WHERE key = ?`, args: [KEY_SYNC]    }),
      client.execute(`SELECT COUNT(*) as n FROM amazon_orders`),
      client.execute(`SELECT COUNT(*) as n FROM amazon_order_matches`),
    ]);
    return {
      connected:    tokenRow.rows.length > 0,
      lastSync:     (syncRow.rows[0]?.value as string | undefined) ?? null,
      ordersCount:  Number(ordersRow.rows[0]?.n ?? 0),
      matchedCount: Number(matchesRow.rows[0]?.n ?? 0),
    };
  } catch {
    return { connected: false, lastSync: null, ordersCount: 0, matchedCount: 0 };
  } finally {
    client.close();
  }
}
