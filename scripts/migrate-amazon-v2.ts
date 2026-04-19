/**
 * v2: Replace amazon_orders (one row per order_id) with amazon_shipments
 * (one row per shipment email). Multiple shipments can share the same order_id
 * and their amounts are summed to match one CC transaction.
 *
 * Run: npx tsx scripts/migrate-amazon-v2.ts
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

// One row per shipment email — Gmail message ID is the PK
await db.execute(`
  CREATE TABLE IF NOT EXISTS amazon_shipments (
    message_id    TEXT PRIMARY KEY,
    order_id      TEXT NOT NULL,
    email_date    TEXT NOT NULL,
    amount        REAL NOT NULL,
    items_json    TEXT,
    email_subject TEXT,
    synced_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )
`);
console.log('✓ Created amazon_shipments table');

await db.execute(`CREATE INDEX IF NOT EXISTS idx_shipments_order  ON amazon_shipments(order_id)`);
await db.execute(`CREATE INDEX IF NOT EXISTS idx_shipments_date   ON amazon_shipments(email_date)`);
console.log('✓ Created indexes');

// Seed from existing amazon_orders so we don't lose already-synced data
try {
  const existing = await db.execute(`SELECT order_id, email_date, grand_total, items_json, email_subject FROM amazon_orders`);
  for (const row of existing.rows) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO amazon_shipments (message_id, order_id, email_date, amount, items_json, email_subject)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        `legacy_${row.order_id}`,
        row.order_id as string,
        row.email_date as string,
        row.grand_total as number,
        row.items_json as string | null,
        row.email_subject as string | null,
      ],
    });
  }
  console.log(`✓ Migrated ${existing.rows.length} existing orders into amazon_shipments`);
} catch {
  console.log('  (no existing amazon_orders data to migrate)');
}

console.log('\n✅  Migration complete');
db.close();
