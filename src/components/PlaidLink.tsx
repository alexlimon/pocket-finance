import { useState, useCallback, useEffect } from 'react';
import { usePlaidLink } from 'react-plaid-link';

type Stage = 'idle' | 'fetching-token' | 'ready' | 'linking' | 'exchanging' | 'success' | 'error';

export default function PlaidLinkButton() {
  const [stage,     setStage]     = useState<Stage>('idle');
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error,     setError]     = useState<string | null>(null);
  const [result,    setResult]    = useState<{ accounts: number } | null>(null);

  // When Chase (OAuth) redirects back, the URL contains ?oauth_state_id=...
  // In that case we must resume the Link session immediately on mount.
  const isOAuthReturn = typeof window !== 'undefined' &&
    window.location.href.includes('oauth_state_id=');

  // Only send redirect_uri over HTTPS — Plaid production rejects http://
  const redirectUri = typeof window !== 'undefined' && window.location.protocol === 'https:'
    ? `${window.location.origin}/connect`
    : undefined;

  /** Fetch a fresh link_token, passing our redirect_uri for OAuth banks. */
  async function requestLinkToken() {
    setStage('fetching-token');
    setError(null);
    try {
      const res = await fetch('/api/plaid/link-token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ redirectUri }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { link_token: string };
      setLinkToken(data.link_token);
      setStage('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setStage('error');
    }
  }

  // On OAuth return: auto-fetch a new link token and resume without user click.
  useEffect(() => {
    if (isOAuthReturn && stage === 'idle') {
      requestLinkToken();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Step 2: Plaid Link onSuccess — exchange public token for access token. */
  const onSuccess = useCallback(async (publicToken: string) => {
    setStage('exchanging');
    // Clean the OAuth query params from the URL without reloading
    if (isOAuthReturn) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    try {
      const res = await fetch('/api/plaid/exchange-token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ public_token: publicToken }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { accounts: number };
      setResult(data);
      setStage('success');
      // Kick off initial sync in background
      fetch('/api/plaid/sync', { method: 'POST' }).catch(() => null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Exchange failed');
      setStage('error');
    }
  }, [isOAuthReturn]);

  const { open, ready } = usePlaidLink({
    token:               linkToken ?? '',
    // Pass the current URL as receivedRedirectUri when returning from OAuth
    receivedRedirectUri: isOAuthReturn ? window.location.href : undefined,
    onSuccess:           (public_token) => onSuccess(public_token),
    onExit:              () => { if (stage !== 'success') setStage('idle'); },
  });

  // Open Link as soon as the SDK is ready (after token fetch OR OAuth return)
  useEffect(() => {
    if (stage === 'ready' && ready && linkToken) {
      setStage('linking');
      open();
    }
  }, [stage, ready, linkToken, open]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (stage === 'success') {
    return (
      <div className="rounded-lg bg-emerald-950/30 border border-emerald-900/40 p-4 text-sm text-emerald-400">
        ✓ Connected! {result?.accounts ?? 0} account{result?.accounts !== 1 ? 's' : ''} imported.{' '}
        Initial sync running in background.
        <button
          className="ml-3 text-xs underline opacity-60 hover:opacity-100"
          onClick={() => { setStage('idle'); setLinkToken(null); setResult(null); }}
        >Add another</button>
      </div>
    );
  }

  if (stage === 'error') {
    return (
      <div className="rounded-lg bg-red-950/30 border border-red-900/40 p-4 text-sm text-red-400">
        <p className="font-medium">Connection failed</p>
        <p className="mt-1 text-xs opacity-80">{error ?? 'Something went wrong.'}</p>
        <button
          className="mt-2 text-xs underline opacity-60 hover:opacity-100"
          onClick={() => { setStage('idle'); setError(null); }}
        >Try again</button>
      </div>
    );
  }

  // Show a spinner while auto-resuming an OAuth return
  if (isOAuthReturn && stage !== 'idle') {
    return (
      <div className="flex items-center gap-2 text-sm text-stone-500">
        <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        Completing bank connection…
      </div>
    );
  }

  const isLoading = stage === 'fetching-token' || stage === 'exchanging' || stage === 'linking';

  return (
    <button
      onClick={requestLinkToken}
      disabled={isLoading}
      className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {isLoading ? (
        <>
          <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          {stage === 'exchanging' ? 'Connecting…' : 'Opening Plaid…'}
        </>
      ) : (
        <>+ Connect Bank Account</>
      )}
    </button>
  );
}
