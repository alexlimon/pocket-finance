/**
 * Dumps the whole Turso database to a local SQL file (schema + data).
 * Run: npm run backup
 *
 * Output: backups/pocket-finance-<UTC timestamp>.sql — plain SQL, restorable with
 * either sqlite3 or `turso db shell <db> < backups/<file>.sql`.
 *
 * backups/ is gitignored: the dump contains full financial history in plaintext.
 */
import { createClient } from '@libsql/client';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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

/** Render one value as a SQL literal. */
function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const b = Buffer.from(v instanceof ArrayBuffer ? v : (v as Uint8Array).buffer);
    return `X'${b.toString('hex')}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

const objects = await db.execute(
  `SELECT type, name, sql FROM sqlite_master
   WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
   ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name`
);
const tables = objects.rows.filter(r => r.type === 'table').map(r => String(r.name));

const out: string[] = [
  `-- pocket-finance backup — ${new Date().toISOString()}`,
  `-- source: ${vars['TURSO_DATABASE_URL']}`,
  'PRAGMA foreign_keys=OFF;',
  'BEGIN TRANSACTION;',
  '',
];

const counts: Record<string, number> = {};

// Schema for tables first, so inserts below have somewhere to land.
for (const r of objects.rows.filter(o => o.type === 'table')) {
  out.push(`${String(r.sql).trim()};`);
}
out.push('');

for (const t of tables) {
  const rows = await db.execute(`SELECT * FROM "${t}"`);
  counts[t] = rows.rows.length;
  if (!rows.rows.length) continue;
  const cols = rows.columns.map(c => `"${c}"`).join(', ');
  out.push(`-- ${t} (${rows.rows.length} rows)`);
  for (const row of rows.rows) {
    const vals = rows.columns.map(c => lit((row as any)[c])).join(', ');
    out.push(`INSERT INTO "${t}" (${cols}) VALUES (${vals});`);
  }
  out.push('');
}

// Indexes, views and triggers after the data — faster, and avoids ordering traps.
for (const r of objects.rows.filter(o => o.type !== 'table')) {
  out.push(`${String(r.sql).trim()};`);
}
out.push('COMMIT;', 'PRAGMA foreign_keys=ON;', '');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
const dir   = resolve(__dirname, '../backups');
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `pocket-finance-${stamp}.sql`);
writeFileSync(file, out.join('\n'), 'utf-8');

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`Wrote ${file}`);
console.log(`${tables.length} tables, ${total} rows total:`);
for (const t of tables.sort()) console.log(`  ${t.padEnd(24)} ${counts[t]}`);
