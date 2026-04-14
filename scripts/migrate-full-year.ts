/**
 * Seeds/updates monthly_summary for all 12 months of 2026
 * from the spreadsheet estimates. Existing actuals are preserved
 * for Jan–Mar (INSERT OR IGNORE for those, UPSERT for Apr–Dec).
 *
 * Run: npx tsx scripts/migrate-full-year.ts
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

// Full year extracted directly from "Maham + Alex Budget-4.xlsx" → 2026 Budget tab
// Rows: checking_before(4), checking_after(5), savings_before(7), savings_after(8),
//       income_maham(13), income_alex(14), cc_budget/payment(27)
const yearData = [
  { month:'2026-01', income_alex:8038,    income_maham:9838,    income_other:3500, checking_before:4549.66, checking_after:5740.50, savings_before:6900,  savings_after:7000,  cc_budget:7532.01 },
  { month:'2026-02', income_alex:8038,    income_maham:6573.30, income_other:3500, checking_before:5740.50, checking_after:1543.71, savings_before:7000,  savings_after:9000,  cc_budget:7303.88 },
  { month:'2026-03', income_alex:8027.48, income_maham:6571.32, income_other:3500, checking_before:1543.71, checking_after:4041.59, savings_before:9000,  savings_after:9000,  cc_budget:4818.16 },
  { month:'2026-04', income_alex:8027.48, income_maham:6571.32, income_other:3500, checking_before:4041.59, checking_after:1677.17, savings_before:9000,  savings_after:11000, cc_budget:5645.38 },
  { month:'2026-05', income_alex:13017,   income_maham:6571.32, income_other:3500, checking_before:1677.17, checking_after:1651.89, savings_before:11000, savings_after:21000, cc_budget:7200.00 },
  { month:'2026-06', income_alex:8246,    income_maham:6571.32, income_other:3500, checking_before:1651.89, checking_after:1745.61, savings_before:21000, savings_after:23000, cc_budget:5000.00 },
  { month:'2026-07', income_alex:8246,    income_maham:9856.98, income_other:3500, checking_before:1745.61, checking_after:2859.99, savings_before:23000, savings_after:26000, cc_budget:5000.00 },
  { month:'2026-08', income_alex:8246,    income_maham:6571.32, income_other:3500, checking_before:2859.99, checking_after:2953.71, savings_before:26000, savings_after:28000, cc_budget:5000.00 },
  { month:'2026-09', income_alex:8246,    income_maham:6571.32, income_other:3500, checking_before:2953.71, checking_after:3047.43, savings_before:28000, savings_after:30000, cc_budget:5000.00 },
  { month:'2026-10', income_alex:12369,   income_maham:6571.32, income_other:3500, checking_before:3047.43, checking_after:2812.28, savings_before:30000, savings_after:34000, cc_budget:5000.00 },
  { month:'2026-11', income_alex:8246,    income_maham:6571.32, income_other:3500, checking_before:2812.28, checking_after:1006.00, savings_before:34000, savings_after:34000, cc_budget:5000.00 },
  { month:'2026-12', income_alex:8246,    income_maham:6571.32, income_other:3500, checking_before:1006.00, checking_after:1099.72, savings_before:34000, savings_after:36000, cc_budget:5000.00 },
];

// Jan–Mar already have real data seeded — only update income + cc_budget,
// don't overwrite the actual balances the user may have edited.
const ACTUALS = new Set(['2026-01', '2026-02', '2026-03']);

for (const row of yearData) {
  if (ACTUALS.has(row.month)) {
    // Only patch income + cc_budget; leave balances as-is
    await db.execute({
      sql: `UPDATE monthly_summary
            SET income_alex = ?, income_maham = ?, income_other = ?, cc_budget = ?
            WHERE month = ?`,
      args: [row.income_alex, row.income_maham, row.income_other, row.cc_budget, row.month],
    });
    console.log(`  Updated income/CC budget for ${row.month}`);
  } else {
    // Full upsert for future months — spreadsheet estimates
    await db.execute({
      sql: `INSERT INTO monthly_summary
              (month, income_alex, income_maham, income_other,
               checking_before, checking_after, savings_before, savings_after, cc_budget)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(month) DO UPDATE SET
              income_alex     = excluded.income_alex,
              income_maham    = excluded.income_maham,
              income_other    = excluded.income_other,
              checking_before = excluded.checking_before,
              checking_after  = excluded.checking_after,
              savings_before  = excluded.savings_before,
              savings_after   = excluded.savings_after,
              cc_budget       = excluded.cc_budget`,
      args: [row.month, row.income_alex, row.income_maham, row.income_other,
             row.checking_before, row.checking_after, row.savings_before,
             row.savings_after, row.cc_budget],
    });
    console.log(`  Seeded ${row.month}`);
  }
}

db.close();
console.log('\n✅  Full year migration complete — all 12 months seeded.');
