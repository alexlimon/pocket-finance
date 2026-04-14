/**
 * v6: Add cc_recurring_budget column to monthly_summary and populate
 *     from the spreadsheet's "Credit Card Recurring" row.
 *
 *     cc_budget[M]           = variable component of CC payment going out in month M
 *     cc_recurring_budget[M] = recurring component of CC payment going out in month M
 *     CC payment for month M = cc_budget[M] + cc_recurring_budget[M]
 *
 *     The CC spending budget displayed to user for month M = cc_budget[M+1]
 *     (next month's cc_budget = this month's variable CC spend, paid next month)
 *
 * Run: npx tsx scripts/migrate-v6.ts
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

// Add column (ignore if already exists)
try {
  await db.execute(`ALTER TABLE monthly_summary ADD COLUMN cc_recurring_budget REAL DEFAULT NULL`);
  console.log('✓ Added cc_recurring_budget column');
} catch (e: any) {
  if (e.message?.includes('duplicate column')) {
    console.log('  cc_recurring_budget column already exists, skipping');
  } else throw e;
}

// Spreadsheet "Credit Card Recurring" values by month
// Source: Maham + Alex Budget-4.xlsx — payment-month organized
const data: [string, number][] = [
  // 2024
  ['2024-01', 676.20],
  ['2024-02', 597.33],
  ['2024-03', 638.97],
  ['2024-04', 640.57],
  ['2024-05', 658.28],
  ['2024-06', 659.62],
  ['2024-07', 627.78],
  ['2024-08', 592.49],
  ['2024-09', 634.65],
  ['2024-10', 1506.64],
  ['2024-11', 2111.09],
  ['2024-12', 671.43],
  // 2025
  ['2025-01', 680.11],
  ['2025-02', 580.79],
  ['2025-03', 670.24],
  ['2025-04', 671.50],
  ['2025-05', 559.25],
  ['2025-06', 550.93],
  ['2025-07', 647.60],
  ['2025-08', 601.05],
  ['2025-09', 695.23],
  ['2025-10', 576.22],
  ['2025-11', 493.27],
  ['2025-12', 632.19],
  // 2026
  ['2026-01', 559.82],
  ['2026-02', 662.40],
  ['2026-03', 699.81],
  ['2026-04', 532.37],
  ['2026-05', 372.87],
];

let updated = 0;
for (const [month, amount] of data) {
  const r = await db.execute({
    sql: `UPDATE monthly_summary SET cc_recurring_budget = ? WHERE month = ?`,
    args: [amount, month],
  });
  if (r.rowsAffected > 0) {
    console.log(`  ✓ ${month}: cc_recurring_budget = ${amount}`);
    updated++;
  } else {
    console.log(`  ⚠ ${month}: no row in monthly_summary, skipping`);
  }
}

console.log(`\n✅  v6 migration complete — updated ${updated} months`);
db.close();
