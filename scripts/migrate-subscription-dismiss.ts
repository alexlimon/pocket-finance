/**
 * Create subscription_dismissals table for hiding non-subscription vendors
 * detected by the Analyze > Subscriptions scan.
 * Keyed on (vendor_alias, account_last4) — the same key the detector groups by.
 * Run: npm run migrate:dismiss
 */
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
function readDevVars(): Record<string, string> {
  const c = readFileSync(resolve(__dirname, '../.dev.vars'), 'utf-8');
  const r: Record<string, string> = {};
  for (const line of c.split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i > -1) r[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return r;
}

const vars = readDevVars();
const db = createClient({ url: vars['TURSO_DATABASE_URL']!, authToken: vars['TURSO_AUTH_TOKEN']! });

await db.execute(`
  CREATE TABLE IF NOT EXISTS subscription_dismissals (
    vendor_alias  TEXT NOT NULL,
    account_last4 TEXT NOT NULL,
    dismissed_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (vendor_alias, account_last4)
  )
`);
console.log('✓ Created subscription_dismissals table');

console.log('\n✅  Migration complete');
db.close();
