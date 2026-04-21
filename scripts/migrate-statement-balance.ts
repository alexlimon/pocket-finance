/**
 * Adds statement_balance column to cc_variable_spend.
 * Seeds April 2026 sapphire statement_balance = 4412.95 (the locked statement amount
 * after the billing cutoff on Apr 18, before post-statement charges).
 *
 * Run: npx tsx scripts/migrate-statement-balance.ts
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
  // Add column (idempotent — SQLite ignores duplicate column errors)
  try {
    await db.execute('ALTER TABLE cc_variable_spend ADD COLUMN statement_balance REAL');
    console.log('✓ Added statement_balance column');
  } catch (e: any) {
    if (e.message?.includes('duplicate column')) {
      console.log('  statement_balance column already exists, skipping');
    } else {
      throw e;
    }
  }

  // Seed April 2026 sapphire: lock statement at 4412.95 and fix the displayed amount
  await db.execute({
    sql: `UPDATE cc_variable_spend SET statement_balance = 4412.95, amount = 4412.95
          WHERE month = '2026-04' AND card = 'sapphire'`,
    args: [],
  });
  console.log('✓ Set 2026-04 sapphire statement_balance = 4412.95, amount = 4412.95');

  // Add balance_updated_at column
  try {
    await db.execute('ALTER TABLE cc_variable_spend ADD COLUMN balance_updated_at TEXT');
    console.log('✓ Added balance_updated_at column');
  } catch (e: any) {
    if (e.message?.includes('duplicate column')) {
      console.log('  balance_updated_at column already exists, skipping');
    } else {
      throw e;
    }
  }

  // Verify
  const r = await db.execute(
    `SELECT month, card, amount, statement_balance, balance_updated_at
     FROM cc_variable_spend WHERE month IN ('2026-04','2026-05') ORDER BY month, card`,
  );
  console.log('\nVerification:');
  for (const row of r.rows) {
    console.log(`  ${row.month} ${String(row.card).padEnd(10)} amount=${row.amount}  statement_balance=${row.statement_balance}  balance_updated_at=${row.balance_updated_at}`);
  }
}

main().catch(console.error);
