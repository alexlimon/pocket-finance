/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface CloudflareEnv {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN:   string;
  PLAID_CLIENT_ID:    string;
  PLAID_SECRET:       string;
  PLAID_ENV:          'sandbox' | 'production';
}

type Runtime = import('@astrojs/cloudflare').Runtime<CloudflareEnv>;

declare namespace App {
  interface Locals extends Runtime {}
}
