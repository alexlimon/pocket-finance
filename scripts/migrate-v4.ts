/**
 * v4: Replace free-form cc_charges variable entries with
 *     a simple per-card monthly aggregate table (cc_variable_spend).
 *     Existing variable entries are rolled up and migrated.
 *
 * Run: npx tsx scripts/migrate-v4.ts
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
    const i = t.indexOf('='); if (i > -1) r[t.slice(0,i).trim()] = t.slice(i+1).trim();
  }
  return r;
}
const vars = readDevVars();
const db = createClient({ url: vars['TURSO_DATABASE_URL'], authToken: vars['TURSO_AUTH_TOKEN'] });

// ── Create cc_variable_spend ──────────────────────────────────────────────────
await db.execute(`
  CREATE TABLE IF NOT EXISTS cc_variable_spend (
    month  TEXT NOT NULL,  -- 'YYYY-MM'
    card   TEXT NOT NULL,  -- 'sapphire' | 'prime' | 'apple' | 'other'
    amount REAL DEFAULT 0,
    PRIMARY KEY (month, card)
  )
`);
console.log('✓ cc_variable_spend table created');

// ── Roll up existing variable cc_charges into cc_variable_spend ───────────────
const existing = await db.execute(`
  SELECT month, card, SUM(amount) as total
  FROM cc_charges
  WHERE is_big_purchase = 0
  GROUP BY month, card
`);

let migrated = 0;
for (const r of existing.rows) {
  await db.execute({
    sql: `INSERT INTO cc_variable_spend (month, card, amount) VALUES (?, ?, ?)
          ON CONFLICT(month, card) DO UPDATE SET amount = excluded.amount`,
    args: [r.month, r.card, r.total],
  });
  migrated++;
}
console.log(`✓ Migrated ${migrated} variable CC rows`);

// Remove variable entries from cc_charges (keep big purchases)
const deleted = await db.execute(`DELETE FROM cc_charges WHERE is_big_purchase = 0`);
console.log(`✓ Removed ${deleted.rowsAffected} old variable entries from cc_charges`);

// ── Ensure all 12 months × 3 cards have rows (default 0) ────────────────────
const months  = Array.from({length:12},(_,i)=>`2026-${String(i+1).padStart(2,'0')}`);
const cards   = ['sapphire','prime','apple'];
let ensured   = 0;
for (const month of months) {
  for (const card of cards) {
    await db.execute({
      sql:  `INSERT OR IGNORE INTO cc_variable_spend (month, card, amount) VALUES (?, ?, 0)`,
      args: [month, card],
    });
    ensured++;
  }
}
console.log(`✓ Ensured ${ensured} month×card rows for 2026`);

db.close();
console.log('\n✅  v4 migration complete');
