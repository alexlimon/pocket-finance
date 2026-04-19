/**
 * Create amazon_orders and amazon_order_matches tables.
 * Run: npx tsx scripts/migrate-amazon-orders.ts
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
  CREATE TABLE IF NOT EXISTS amazon_orders (
    order_id      TEXT PRIMARY KEY,
    email_date    TEXT NOT NULL,
    grand_total   REAL NOT NULL,
    items_json    TEXT,
    email_subject TEXT,
    synced_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )
`);
console.log('✓ Created amazon_orders table');

await db.execute(`
  CREATE TABLE IF NOT EXISTS amazon_order_matches (
    txn_id    TEXT PRIMARY KEY,
    order_id  TEXT NOT NULL REFERENCES amazon_orders(order_id),
    matched_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )
`);
console.log('✓ Created amazon_order_matches table');

await db.execute(`CREATE INDEX IF NOT EXISTS idx_amazon_orders_date  ON amazon_orders(email_date)`);
await db.execute(`CREATE INDEX IF NOT EXISTS idx_amazon_matches_order ON amazon_order_matches(order_id)`);
console.log('✓ Created indexes');

console.log('\n✅  Migration complete');
db.close();
