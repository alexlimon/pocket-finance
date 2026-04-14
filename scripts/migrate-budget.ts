/**
 * Adds the manual-entry budget tables and seeds Jan–Mar 2026 data.
 * Run AFTER npm run seed:   npx tsx scripts/migrate-budget.ts
 */

import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
function readDevVars(): Record<string, string> {
  const contents = readFileSync(resolve(__dirname, '../.dev.vars'), 'utf-8');
  const result: Record<string, string> = {};
  for (const line of contents.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx > -1) result[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return result;
}
const vars = readDevVars();
const db = createClient({ url: vars['TURSO_DATABASE_URL'], authToken: vars['TURSO_AUTH_TOKEN'] });

// ── Schema ────────────────────────────────────────────────────────────────────
console.log('[1/5] Creating tables…');

const ddl = [
  `ALTER TABLE budget_config ADD COLUMN is_cc_default INTEGER DEFAULT 0`,

  `CREATE TABLE IF NOT EXISTS monthly_summary (
    month           TEXT PRIMARY KEY,  -- 'YYYY-MM'
    income_alex     REAL DEFAULT 0,
    income_maham    REAL DEFAULT 0,
    income_other    REAL DEFAULT 0,    -- Kirby rent, etc.
    checking_before REAL DEFAULT 0,
    checking_after  REAL DEFAULT 0,
    savings_before  REAL DEFAULT 0,
    savings_after   REAL DEFAULT 0,
    cc_budget       REAL DEFAULT 5000,
    notes           TEXT
  )`,

  // Per-month status of each recurring bill (sparse: only exists when explicitly set)
  `CREATE TABLE IF NOT EXISTS bill_payments (
    id          TEXT PRIMARY KEY,
    month       TEXT NOT NULL,
    bill_id     TEXT NOT NULL REFERENCES budget_config(id) ON DELETE CASCADE,
    amount      REAL NOT NULL,
    is_paid     INTEGER DEFAULT 0,
    is_cc       INTEGER DEFAULT 0,
    paid_date   TEXT,
    UNIQUE(month, bill_id)
  )`,

  // CC charges: variable spend + big purchases
  `CREATE TABLE IF NOT EXISTS cc_charges (
    id              TEXT PRIMARY KEY,
    month           TEXT NOT NULL,
    date            TEXT,
    description     TEXT NOT NULL,
    amount          REAL NOT NULL,
    card            TEXT NOT NULL DEFAULT 'sapphire',
    is_big_purchase INTEGER DEFAULT 0,
    category_id     TEXT
  )`,

  // Miscellaneous non-CC cash expenses
  `CREATE TABLE IF NOT EXISTS cash_expenses (
    id          TEXT PRIMARY KEY,
    month       TEXT NOT NULL,
    date        TEXT,
    description TEXT NOT NULL,
    amount      REAL NOT NULL,
    entity_id   TEXT DEFAULT 'household'
  )`,
];

for (const sql of ddl) {
  try { await db.execute(sql); }
  catch (e: any) {
    // ALTER TABLE throws if column already exists — safe to ignore
    if (!e.message?.includes('duplicate column')) throw e;
  }
}
console.log('✓ Tables ready');

// ── Add CC subscriptions to budget_config ────────────────────────────────────
console.log('[2/5] Adding subscription recurring items…');

const subs: [string, string, string, number, number][] = [
  // [id, name, category_id, monthly_target, due_day]
  ['bill_icloud',          'iCloud',           'subscriptions',  9.99,   5],
  ['bill_spotify',         'Spotify',          'subscriptions', 19.00,   5],
  ['bill_google_storage',  'Google Storage',   'subscriptions',  5.31,   8],
  ['bill_electricity',     'Electricity',      'utilities',    115.00,  17],
  ['bill_pih',             'PIH Health',       'utilities',     21.40,  17],
  ['bill_peloton',         'Peloton',          'fitness',       52.00,  17],
  ['bill_gas',             'Gas',              'transport',    150.00,  24],
  ['bill_water',           'Water',            'utilities',    152.00,  25],
  ['bill_chatgpt',         'ChatGPT',          'subscriptions', 21.28,  23],
  ['bill_hulu',            'Hulu',             'subscriptions', 35.71,  25],
  ['bill_canva',           'Canva',            'subscriptions', 13.00,  25],
  ['bill_unrwa',           'Unrwa',            'charity',       52.44,  28],
  ['bill_nyt',             'New York Times',   'subscriptions',  4.26,  15],
];

for (const [id, name, category_id, monthly_target, due_day] of subs) {
  await db.execute({
    sql: `INSERT OR IGNORE INTO budget_config
            (id, name, category_id, monthly_target, due_day, is_recurring, entity_id, is_cc_default)
          VALUES (?, ?, ?, ?, ?, 1, 'household', 1)`,
    args: [id, name, category_id, monthly_target, due_day],
  });
}

// Mark CC-default on existing subscription-type bills
await db.execute(`UPDATE budget_config SET is_cc_default = 1
  WHERE id IN ('bill_icloud','bill_spotify','bill_google_storage','bill_electricity',
               'bill_pih','bill_peloton','bill_gas','bill_water','bill_chatgpt',
               'bill_hulu','bill_canva','bill_unrwa','bill_nyt')`);

console.log(`✓ ${subs.length} subscription items`);

// ── Monthly summaries (Jan–Mar actuals from spreadsheet) ─────────────────────
console.log('[3/5] Seeding monthly summaries…');

const summaries: [string, number, number, number, number, number, number, number, number][] = [
  // month, alex, maham, other, chk_before, chk_after, sav_before, sav_after, cc_budget
  ['2026-01', 8038.00, 9838.00, 3500, 4549.66, 5740.50, 6900,  7000, 7532.01],
  ['2026-02', 8038.00, 6573.30, 3500, 5740.50, 1543.71, 7000,  9000, 7303.88],
  ['2026-03', 8027.48, 6571.32, 3500, 1543.71, 4041.59, 9000,  9000, 4818.16],
];

for (const [month, a, m, o, cb, ca, sb, sa, ccb] of summaries) {
  await db.execute({
    sql: `INSERT OR REPLACE INTO monthly_summary
            (month, income_alex, income_maham, income_other,
             checking_before, checking_after, savings_before, savings_after, cc_budget)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [month, a, m, o, cb, ca, sb, sa, ccb],
  });
}
console.log(`✓ ${summaries.length} monthly summaries`);

// ── Bill payments (Jan–Mar, all paid, from spreadsheet actuals) ───────────────
console.log('[4/5] Seeding bill payments…');

type BP = [string, string, number, 0 | 1]; // [month, bill_id, amount, is_cc]
const payments: BP[] = [
  // January
  ['2026-01', 'bill_kirby_mortgage',  2603.51, 0],
  ['2026-01', 'bill_kirby_hoa',        345.00, 0],  // Jan was $345 (arrears)
  ['2026-01', 'bill_kennedy_mortgage',4539.67, 0],
  ['2026-01', 'bill_kennedy_hoa',      575.00, 0],  // quarterly
  ['2026-01', 'bill_nanny',           3415.00, 0],
  ['2026-01', 'bill_cleaning',         320.00, 0],
  ['2026-01', 'bill_internet_phone',   142.28, 0],
  ['2026-01', 'bill_icloud',             9.99, 1],
  ['2026-01', 'bill_spotify',           18.39, 1],
  ['2026-01', 'bill_google_storage',     5.31, 1],
  ['2026-01', 'bill_electricity',      116.67, 1],
  ['2026-01', 'bill_pih',               21.40, 1],
  ['2026-01', 'bill_peloton',           47.63, 1],
  ['2026-01', 'bill_gas',               60.00, 1],
  ['2026-01', 'bill_water',            171.00, 1],
  ['2026-01', 'bill_chatgpt',           21.28, 1],
  ['2026-01', 'bill_hulu',              35.71, 1],
  ['2026-01', 'bill_unrwa',             52.44, 1],
  // February
  ['2026-02', 'bill_kirby_mortgage',  2603.51, 0],
  ['2026-02', 'bill_kirby_hoa',        270.50, 0],
  ['2026-02', 'bill_kennedy_mortgage',4539.67, 0],
  ['2026-02', 'bill_nanny',           2540.00, 0],
  ['2026-02', 'bill_cleaning',         320.00, 0],
  ['2026-02', 'bill_internet_phone',   175.33, 0],
  ['2026-02', 'bill_icloud',             9.99, 1],
  ['2026-02', 'bill_spotify',           18.39, 1],
  ['2026-02', 'bill_google_storage',     5.31, 1],
  ['2026-02', 'bill_electricity',      125.85, 1],
  ['2026-02', 'bill_pih',               21.40, 1],
  ['2026-02', 'bill_peloton',           54.11, 1],
  ['2026-02', 'bill_gas',              174.92, 1],
  ['2026-02', 'bill_water',            143.00, 1],
  ['2026-02', 'bill_chatgpt',           21.28, 1],
  ['2026-02', 'bill_hulu',              35.71, 1],
  ['2026-02', 'bill_unrwa',             52.44, 1],
  ['2026-02', 'bill_nyt',                4.26, 1],
  // March
  ['2026-03', 'bill_kirby_mortgage',  2603.51, 0],
  ['2026-03', 'bill_kirby_hoa',        270.50, 0],
  ['2026-03', 'bill_kennedy_mortgage',4539.67, 0],
  ['2026-03', 'bill_nanny',           2692.00, 0],
  ['2026-03', 'bill_cleaning',         640.00, 0],  // double month
  ['2026-03', 'bill_internet_phone',   382.00, 0],
  ['2026-03', 'bill_icloud',             9.99, 1],
  ['2026-03', 'bill_spotify',           18.39, 1],
  ['2026-03', 'bill_google_storage',     5.31, 1],
  ['2026-03', 'bill_electricity',      102.52, 1],
  ['2026-03', 'bill_pih',               21.40, 1],
  ['2026-03', 'bill_peloton',           54.11, 1],
  ['2026-03', 'bill_gas',              209.72, 1],
  ['2026-03', 'bill_water',            143.04, 1],
  ['2026-03', 'bill_chatgpt',           21.28, 1],
  ['2026-03', 'bill_hulu',              35.71, 1],
  ['2026-03', 'bill_unrwa',             52.44, 1],
  ['2026-03', 'bill_nyt',                4.26, 1],
  ['2026-03', 'bill_canva',             21.64, 1],
];

for (const [month, bill_id, amount, is_cc] of payments) {
  const pid = `bp_${month}_${bill_id}`;
  await db.execute({
    sql: `INSERT OR REPLACE INTO bill_payments (id, month, bill_id, amount, is_paid, is_cc)
          VALUES (?, ?, ?, ?, 1, ?)`,
    args: [pid, month, bill_id, amount, is_cc],
  });
}
console.log(`✓ ${payments.length} bill payments`);

// ── CC charges — variable spend per card per month ────────────────────────────
// Total per card minus the CC recurring = variable general spend
// Jan: Sapphire 6398, Prime 1491.27, Apple 202.56  (recurring 559.82 = on Sapphire)
// Feb: Sapphire 7012, Prime  606.23, Apple 348.05  (recurring 662.40)
// Mar: Sapphire 4614.57, Prime 876.16, Apple 27.24 (recurring 699.81)
console.log('[5/5] Seeding CC charges…');

// Sapphire variable = total - CC recurring (already captured in bill_payments)
const charges: [string, string, string, number, string, 0|1][] = [
  // [month, description, card, amount, category, is_big_purchase]
  ['2026-01', 'General Spending — Sapphire', 'sapphire', 5838.18, 'miscellaneous', 0],
  ['2026-01', 'General Spending — Prime',    'prime',    1491.27, 'miscellaneous', 0],
  ['2026-01', 'Apple Card Charges',          'apple',     202.56, 'miscellaneous', 0],
  ['2026-02', 'General Spending — Sapphire', 'sapphire', 6349.60, 'miscellaneous', 0],
  ['2026-02', 'General Spending — Prime',    'prime',     606.23, 'miscellaneous', 0],
  ['2026-02', 'Apple Card Charges',          'apple',     348.05, 'miscellaneous', 0],
  ['2026-03', 'General Spending — Sapphire', 'sapphire', 3914.76, 'miscellaneous', 0],
  ['2026-03', 'General Spending — Prime',    'prime',     876.16, 'miscellaneous', 0],
  ['2026-03', 'Apple Card Charges',          'apple',      27.24, 'miscellaneous', 0],
];

for (const [month, description, card, amount, category_id, is_big] of charges) {
  const cid = `cc_${month}_${card}`;
  await db.execute({
    sql: `INSERT OR REPLACE INTO cc_charges (id, month, description, card, amount, category_id, is_big_purchase)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [cid, month, description, card, amount, category_id, is_big],
  });
}
console.log(`✓ ${charges.length} CC charges`);

db.close();
console.log('\n✅  Migration complete. Run: npm run dev');
