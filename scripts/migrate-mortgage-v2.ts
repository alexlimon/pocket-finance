/**
 * Mortgage v2: Replace balance/payment with original_amount + start_date.
 * Monthly P&I is now computed from those two fields + rate.
 *
 * Run: npx tsx scripts/migrate-mortgage-v2.ts
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
const db = createClient({ url: vars['TURSO_DATABASE_URL'], authToken: vars['TURSO_AUTH_TOKEN'] });

for (const col of ['original_amount REAL DEFAULT 0', 'start_date TEXT DEFAULT NULL']) {
  try {
    await db.execute(`ALTER TABLE mortgage_accounts ADD COLUMN ${col}`);
    console.log(`✓ Added ${col.split(' ')[0]}`);
  } catch (e: any) {
    if (e.message?.includes('duplicate column')) console.log(`  ${col.split(' ')[0]} already exists`);
    else throw e;
  }
}

console.log('\n✅  mortgage v2 migration complete');
db.close();
