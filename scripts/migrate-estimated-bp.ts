/**
 * Adds is_estimated column to cc_charges (INTEGER DEFAULT 0).
 * Estimated big purchases reserve budget but auto-expire once the estimated
 * date passes (date < today).
 *
 * Run: npx tsx scripts/migrate-estimated-bp.ts
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

async function main() {
  try {
    await db.execute('ALTER TABLE cc_charges ADD COLUMN is_estimated INTEGER DEFAULT 0');
    console.log('✓ Added is_estimated column to cc_charges');
  } catch (e: any) {
    if (e.message?.includes('duplicate column')) {
      console.log('  is_estimated column already exists, skipping');
    } else {
      throw e;
    }
  }
}
main().catch(console.error);