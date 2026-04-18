/** Plaid API client using raw fetch — guaranteed compatible with Cloudflare Workers. */

type PlaidEnv = Pick<CloudflareEnv, 'PLAID_CLIENT_ID' | 'PLAID_SECRET' | 'PLAID_ENV'>;

function baseUrl(env: PlaidEnv): string {
  return env.PLAID_ENV === 'production'
    ? 'https://production.plaid.com'
    : 'https://sandbox.plaid.com';
}

async function plaidPost<T>(endpoint: string, body: object, env: PlaidEnv): Promise<T> {
  const response = await fetch(`${baseUrl(env)}${endpoint}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret:    env.PLAID_SECRET,
      ...body,
    }),
  });

  if (!response.ok) {
    let detail: unknown = null;
    try { detail = await response.json(); } catch { /* ignore */ }
    throw new Error(`Plaid ${endpoint} failed (${response.status}): ${JSON.stringify(detail)}`);
  }

  return response.json() as Promise<T>;
}

// ── Link Token ──────────────────────────────────────────────────────────────

export interface LinkTokenResponse {
  link_token:  string;
  expiration:  string;
  request_id:  string;
}

export async function createLinkToken(
  env: PlaidEnv,
  redirectUri?: string,
): Promise<LinkTokenResponse> {
  return plaidPost<LinkTokenResponse>('/link/token/create', {
    user:           { client_user_id: 'household' },
    client_name:    'Pocket Finance',
    products:       ['transactions'],
    country_codes:  ['US'],
    language:       'en',
    // Required for OAuth institutions (Chase, BofA, etc.) in production
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
  }, env);
}

// ── Token Exchange ───────────────────────────────────────────────────────────

export interface ExchangeTokenResponse {
  access_token: string;
  item_id:      string;
  request_id:   string;
}

export async function exchangePublicToken(
  publicToken: string,
  env: PlaidEnv,
): Promise<ExchangeTokenResponse> {
  return plaidPost<ExchangeTokenResponse>('/item/public_token/exchange', {
    public_token: publicToken,
  }, env);
}

// ── Accounts ────────────────────────────────────────────────────────────────

export interface PlaidAccount {
  account_id:    string;
  name:          string;
  official_name: string | null;
  type:          string;
  subtype:       string | null;
  balances: {
    current:   number | null;
    available: number | null;
    limit:     number | null;
  };
}

export async function getAccounts(
  accessToken: string,
  env: PlaidEnv,
): Promise<PlaidAccount[]> {
  const data = await plaidPost<{ accounts: PlaidAccount[] }>('/accounts/get', {
    access_token: accessToken,
  }, env);
  return data.accounts;
}
