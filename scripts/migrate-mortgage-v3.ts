/**
 * Mortgage v3: Add extra_start_date column.
 *
 * Run: npx tsx scripts/migrate-mortgage-v3.ts
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

try {
  await db.execute(`ALTER TABLE mortgage_accounts ADD COLUMN extra_start_date TEXT DEFAULT NULL`);
  console.log('✓ Added extra_start_date');
} catch (e: any) {
  if (e.message?.includes('duplicate column')) console.log('  extra_start_date already exists');
  else throw e;
}

console.log('\n✅  mortgage v3 migration complete');
db.close();
