# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev             # Start dev server (HTTPS if certs/key.pem + certs/cert.pem exist)
npm run build           # Production build (outputs to dist/)
npm run preview         # Preview production build via Wrangler
npm run check           # TypeScript type-check via astro check
npm run seed            # Run scripts/seed.ts to populate DB
npm run init            # Import from Google Sheet via scripts/init-from-sheet.ts
npm run migrate         # Run scripts/migrate-budget.ts
npm run migrate:billing # Run scripts/migrate-billing.ts
```

There are no unit tests. Type-checking (`npm run check`) is the primary correctness gate.

**Dev server requires Node 20+** — `File` is not a global in Node 18 and the Cloudflare adapter will crash on startup. Workaround if stuck on Node 18: `NODE_OPTIONS="--require /tmp/file-polyfill.cjs" npm run dev` where the polyfill sets `global.File = require('buffer').File`.

**Node 20 via Homebrew** — The system default may be Node 18 even after `brew link node@20`. If `node --version` still shows 18, prefix commands with the explicit path:
```bash
PATH="/opt/homebrew/opt/node@20/bin:$PATH" npm run dev
```
To make Node 20 the persistent default, add that PATH prefix to your shell profile (`~/.zshrc`).

**Local secrets** go in `.dev.vars` (gitignored). Required keys:
```
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=sandbox
```

## Architecture

**Stack:** Astro (SSR, server output) + React (islands) + Tailwind, deployed to Cloudflare Pages. Database is Turso (libSQL / SQLite-compatible), accessed via `@libsql/client/web`.

**Cloudflare runtime env** is accessed as `context.locals.runtime.env` in API routes and `Astro.locals.runtime.env` in `.astro` frontmatter. The `CloudflareEnv` interface is declared in [src/env.d.ts](src/env.d.ts). Secrets are set via Cloudflare dashboard or `.dev.vars` locally; see [wrangler.toml](wrangler.toml).

**Auth:** Single-household password. The session token is stored in the `settings` DB table and validated per-request in `verifySession()` ([src/lib/auth.ts](src/lib/auth.ts)). Every page and API route must call this before any data access.

**Database pattern:** Every API route and page creates a per-request client via `getClient(env)` from [src/lib/db.ts](src/lib/db.ts) and must close it in a `finally` block. There is no ORM — all queries are raw SQL via `client.execute({ sql, args })`.

**Plaid amount convention:** Positive amounts = money leaving (debit/expense). Negative amounts = money arriving (credit/income). This is Plaid's native sign convention and is used throughout all finance calculations.

## Key lib modules

| File | Purpose |
|------|---------|
| [src/lib/db.ts](src/lib/db.ts) | `getClient()`, `json()` response helper |
| [src/lib/auth.ts](src/lib/auth.ts) | Session and password management |
| [src/lib/finance.ts](src/lib/finance.ts) | Pure financial calculations (safe-to-spend, status light, projections) — no DB |
| [src/lib/budget.ts](src/lib/budget.ts) | Types and helpers for the manual-entry budget system (`MonthlySummary`, `BillConfig`, etc.) |
| [src/lib/budget-calc.ts](src/lib/budget-calc.ts) | Pure business logic for the monthly budget page (bill resolution, CC payment, balances) |
| [src/lib/insights.ts](src/lib/insights.ts) | Pure macro aggregates for the dashboard (burn line, Sankey, structural baseline) |
| [src/lib/plaid.ts](src/lib/plaid.ts) | Plaid API client helpers |

## Data model

Two parallel data systems exist:

1. **Plaid-synced ledger** (original): `plaid_items`, `accounts`, `transactions`, `categories`, `merchant_rules`, `income_sources`. Used by the legacy dashboard/transactions views.

2. **Manual-entry budget system** (primary): `monthly_summary`, `budget_config`, `bill_payments`, `cc_charges`, `cc_variable_spend`, `cash_expenses`. This is the active system driving `budget.astro`, `index.astro` (dashboard), and all `/api/budget/*` routes. See [schema.sql](schema.sql) for the Plaid-side schema; the manual-entry tables were added via migration scripts.

The `monthly_summary` table is the central ledger row for each month, storing income fields, checking/savings before/after balances, and `cc_budget`. Budget page writes go through dedicated API endpoints under `src/pages/api/budget/`.

**Entity concept:** `entity_id` is a string tag (`"alex"`, `"maham"`, `"household"`) used on accounts, transactions, bill configs, and cash expenses to attribute ownership. It's a filter dimension, not a foreign key — there is no entities table.

**CC billing cycle:** CC charges belong to a *statement month* that may differ from the calendar month they're paid. `ccSubPaymentMonth()` in [src/lib/budget.ts](src/lib/budget.ts) maps a charge's statement month to the month it will be paid, based on `cc_settings.billing_end_day`. Always use this when linking charges to payments rather than assuming same-month.

## Pages

- `/` (`index.astro`) — Dashboard: Safe-to-Spend hero, balance snapshot, 12-month burn sparkline, Sankey cash-flow, What-If scenario projector
- `/budget` (`budget.astro`) — Monthly budget: recurring bills, CC charges, cash expenses, balance tracking
- `/budget/year` — Year-at-a-glance view
- `/budget/recurring` — Manage recurring bill configurations
- `/transactions` — Transaction feed (Plaid-based)
- `/connect` — Plaid Link flow

## React islands

- `ImpactCalculator` ([src/components/ImpactCalculator.tsx](src/components/ImpactCalculator.tsx)) — What-If scenario projector; receives `monthBaselines[]` as a serialized prop from `index.astro`
- `PlaidLink` ([src/components/PlaidLink.tsx](src/components/PlaidLink.tsx)) — Plaid Link flow

## Deployment

Deploy target is Cloudflare Pages project **"limetiramisu"** (not "pocket-finance").

```bash
# Build then deploy
npm run build
npx wrangler pages deploy dist --project-name limetiramisu
```

**Authentication:** Use the wrangler CLI's stored OAuth session (via `wrangler login`) — do NOT use `CLOUDFLARE_API_TOKEN`. If that env var is set in the shell, unset it first or it will override the CLI session and fail with an auth error:
```bash
CLOUDFLARE_API_TOKEN= npx wrangler pages deploy dist --project-name limetiramisu
```

**Node version:** wrangler must run under Node 20. Prefix with `PATH="/opt/homebrew/opt/node@20/bin:$PATH"` if the shell still defaults to Node 18.

After deploying, Cloudflare Pages serves from the `limetiramisu` project. **Production secrets** (TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV) must be set in the Cloudflare dashboard under the project's Settings → Environment Variables — they are not deployed from `.dev.vars`.
