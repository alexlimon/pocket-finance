/**
 * v5: Add is_skipped column to bill_payments so recurring bills can be
 *     hidden for a specific month without permanently deleting the recurring config.
 *
 * Run: npx tsx scripts/migrate-v5.ts
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

await db.execute(`ALTER TABLE bill_payments ADD COLUMN is_skipped INTEGER DEFAULT 0`);
console.log('✓ Added is_skipped column to bill_payments');

db.close();
console.log('\n✅  v5 migration complete');
