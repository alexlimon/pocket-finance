/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface CloudflareEnv {
  TURSO_DATABASE_URL:  string;
  TURSO_AUTH_TOKEN:    string;
  PLAID_CLIENT_ID:     string;
  PLAID_SECRET:        string;
  PLAID_ENV:           'sandbox' | 'production';
  GOOGLE_CLIENT_ID:    string | undefined;
  GOOGLE_CLIENT_SECRET: string | undefined;
  MEALS_ORIGIN:        string | undefined;   // pocket-meals Pages URL, e.g. https://pocket-meals.pages.dev
  MEALS_SHARED_SECRET: string | undefined;   // must match pocket-meals' MEALS_SHARED_SECRET
}

type Runtime = import('@astrojs/cloudflare').Runtime<CloudflareEnv>;

declare namespace App {
  interface Locals extends Runtime {}
}
