/**
 * v3 migration:
 *  - Adds type (expense|income) to cash_expenses
 *  - Adds start_month / end_month to budget_config
 *  - Seeds Other Cash items from the 2026 spreadsheet (with cell notes as descriptions)
 *
 * Run: npx tsx scripts/migrate-v3.ts
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

// Schema changes
for (const sql of [
  `ALTER TABLE cash_expenses ADD COLUMN type TEXT DEFAULT 'expense'`,
  `ALTER TABLE budget_config ADD COLUMN start_month TEXT`,
  `ALTER TABLE budget_config ADD COLUMN end_month TEXT`,
]) {
  try { await db.execute(sql); console.log('✓', sql.slice(7, 50)); }
  catch (e: any) { if (!e.message?.includes('duplicate column')) throw e; }
}

// Seed Other Cash from spreadsheet rows 32-34 (with notes as descriptions)
// Sign: negative spreadsheet value = expense, positive = income
// type 'expense' = money out, 'income' = money in
const otherCash: {
  month: string; description: string; amount: number; type: 'expense'|'income'; entity_id: string;
}[] = [
  // January
  { month:'2026-01', description:'Bidet installations',   amount: 100,     type:'expense', entity_id:'household' },
  { month:'2026-01', description:'Cash in',               amount: 44,      type:'income',  entity_id:'household' },
  // February
  { month:'2026-02', description:'Taxes',                 amount: 1813,    type:'expense', entity_id:'household' },
  { month:'2026-02', description:'Ramon breaker fix',     amount: 75,      type:'expense', entity_id:'kirby' },
  // March
  { month:'2026-03', description:'Cash income',           amount: 1455.47, type:'income',  entity_id:'household' },
  { month:'2026-03', description:'Layla Birthday',        amount: 450,     type:'expense', entity_id:'household' },
  { month:'2026-03', description:'NET EIDI',              amount: 40,      type:'income',  entity_id:'household' },
  // April
  { month:'2026-04', description:'Car insurance',         amount: 1186.87, type:'expense', entity_id:'household' },
  // May
  { month:'2026-05', description:'Bonus',                 amount: 3000,    type:'income',  entity_id:'household' },
  { month:'2026-05', description:'RSUs',                  amount: 3000,    type:'income',  entity_id:'household' },
  // October
  { month:'2026-10', description:'Car insurance',         amount: 1186.87, type:'expense', entity_id:'household' },
  // November
  { month:'2026-11', description:'Security deposit + pet fee', amount: 3900, type:'expense', entity_id:'household' },
];

for (const row of otherCash) {
  const id = `cash_${row.month}_${row.description.replace(/\s+/g,'_').toLowerCase().slice(0,20)}`;
  await db.execute({
    sql: `INSERT OR IGNORE INTO cash_expenses (id, month, description, amount, type, entity_id)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, row.month, row.description, row.amount, row.type, row.entity_id],
  });
}
console.log(`✓ Seeded ${otherCash.length} Other Cash entries`);

db.close();
console.log('\n✅  v3 migration complete');
