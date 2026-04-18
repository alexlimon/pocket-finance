/**
 * Create csv_transactions table for storing uploaded Chase CSV data.
 * Run: npx tsx scripts/migrate-csv-transactions.ts
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
  CREATE TABLE IF NOT EXISTS csv_transactions (
    id             TEXT PRIMARY KEY,
    account_last4  TEXT NOT NULL,
    account_source TEXT NOT NULL,
    date           TEXT NOT NULL,
    post_date      TEXT,
    description    TEXT NOT NULL,
    category       TEXT,
    type           TEXT,
    amount         REAL NOT NULL,
    memo           TEXT,
    uploaded_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )
`);
console.log('✓ Created csv_transactions table');

await db.execute(`CREATE INDEX IF NOT EXISTS idx_csv_txns_date    ON csv_transactions(date)`);
await db.execute(`CREATE INDEX IF NOT EXISTS idx_csv_txns_account ON csv_transactions(account_last4)`);
console.log('✓ Created indexes');

console.log('\n✅  Migration complete');
db.close();
