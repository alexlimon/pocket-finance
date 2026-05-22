/**
 * v7: Add vendor_alias column to budget_config.
 *
 * vendor_alias stores the normalized CSV vendor string for a CC recurring bill,
 * enabling deterministic matching in the Reconcile flow instead of fuzzy scoring.
 *
 * Run: npx tsx scripts/migrate-v7.ts
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
const db = createClient({ url: vars['TURSO_DATABASE_URL']!, authToken: vars['TURSO_AUTH_TOKEN'] });

try {
  await db.execute(`ALTER TABLE budget_config ADD COLUMN vendor_alias TEXT DEFAULT NULL`);
  console.log('✓ Added vendor_alias column to budget_config');
} catch (e: any) {
  if (e.message?.includes('duplicate column')) {
    console.log('  vendor_alias already exists, skipping');
  } else throw e;
}

console.log('\n✅  v7 migration complete');
db.close();
