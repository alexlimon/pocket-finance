/**
 * Adds billing-cycle tracking tables.
 * Run: npx tsx scripts/migrate-billing.ts
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

// ── Per-card billing cycle configuration ──────────────────────────────────────
await db.execute(`
  CREATE TABLE IF NOT EXISTS cc_settings (
    card             TEXT PRIMARY KEY,   -- 'sapphire' | 'prime' | 'apple' | 'other'
    display_name     TEXT NOT NULL,
    billing_end_day  INTEGER NOT NULL DEFAULT 18,  -- day of month statement closes
    payment_day      INTEGER NOT NULL DEFAULT 15,  -- day of FOLLOWING month payment is due
    credit_limit     REAL
  )
`);

// Seed defaults
const defaults: [string, string, number, number][] = [
  ['sapphire', 'Sapphire Reserve', 18, 15],
  ['prime',    'Prime Visa',       18, 15],
  ['apple',    'Apple Card',       18, 15],
  ['other',    'Other Card',       18, 15],
];
for (const [card, display_name, billing_end_day, payment_day] of defaults) {
  await db.execute({
    sql: `INSERT OR IGNORE INTO cc_settings (card, display_name, billing_end_day, payment_day) VALUES (?,?,?,?)`,
    args: [card, display_name, billing_end_day, payment_day],
  });
}

// ── Add payment_month to cc_charges ──────────────────────────────────────────
try {
  await db.execute(`ALTER TABLE cc_charges ADD COLUMN payment_month TEXT`);
  console.log('Added payment_month column to cc_charges');
} catch (e: any) {
  if (!e.message?.includes('duplicate column')) throw e;
  console.log('payment_month column already exists');
}

// Back-fill payment_month for existing charges that have a date
const existing = await db.execute(`SELECT id, date, card FROM cc_charges WHERE date IS NOT NULL AND payment_month IS NULL`);
const settings = await db.execute(`SELECT card, billing_end_day FROM cc_settings`);
const billingMap: Record<string, number> = {};
for (const r of settings.rows) billingMap[String(r.card)] = Number(r.billing_end_day);

for (const row of existing.rows) {
  const date = String(row.date);
  const card = String(row.card);
  const endDay = billingMap[card] ?? 18;
  const day = Number(date.split('-')[2]);
  const [yr, mo] = date.split('-').map(Number);
  const payD = day <= endDay
    ? new Date(yr, mo, 1)        // next month (mo is 1-indexed → JS month = mo = next)
    : new Date(yr, mo + 1, 1);   // month after next
  const paymentMonth = `${payD.getFullYear()}-${String(payD.getMonth() + 1).padStart(2, '0')}`;
  await db.execute({ sql: `UPDATE cc_charges SET payment_month = ? WHERE id = ?`, args: [paymentMonth, row.id] });
}

db.close();
console.log('✅  Billing migration complete');
