/**
 * Mortgage: Create mortgage_accounts table and seed Kirby + Kennedy defaults.
 *
 * Run: npx tsx scripts/migrate-mortgage.ts
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

await db.execute(`
  CREATE TABLE IF NOT EXISTS mortgage_accounts (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    balance    REAL DEFAULT 0,
    rate       REAL DEFAULT 6.5,
    payment    REAL DEFAULT 0,
    escrow     REAL DEFAULT 0,
    extra      REAL DEFAULT 0,
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )
`);
console.log('✓ Created mortgage_accounts table');

const defaults = [
  { id: 'kirby',   name: 'Kirby',   rate: 6.5, payment: 2200, escrow: 500 },
  { id: 'kennedy', name: 'Kennedy', rate: 7.0, payment: 1800, escrow: 400 },
];

for (const d of defaults) {
  await db.execute({
    sql: `INSERT OR IGNORE INTO mortgage_accounts (id, name, rate, payment, escrow) VALUES (?, ?, ?, ?, ?)`,
    args: [d.id, d.name, d.rate, d.payment, d.escrow],
  });
  console.log(`  ✓ Seeded ${d.name}`);
}

console.log('\n✅  mortgage migration complete');
db.close();
