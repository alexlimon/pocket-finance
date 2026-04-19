/**
 * v3: Recreate amazon_order_matches without the FK to amazon_orders.
 * Order IDs now live in amazon_shipments, not amazon_orders.
 *
 * Run: npx tsx scripts/migrate-amazon-v3.ts
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

await db.execute(`DROP TABLE IF EXISTS amazon_order_matches`);
await db.execute(`
  CREATE TABLE amazon_order_matches (
    txn_id     TEXT PRIMARY KEY,
    order_id   TEXT NOT NULL,
    matched_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )
`);
await db.execute(`CREATE INDEX IF NOT EXISTS idx_amazon_matches_order ON amazon_order_matches(order_id)`);
console.log('✓ Recreated amazon_order_matches without FK constraint');

console.log('\n✅  Migration complete');
db.close();
