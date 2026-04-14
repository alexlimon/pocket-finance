/**
 * pocket-finance — Initialize from "Maham + Alex Budget-4.xlsx" (2026 Budget tab)
 *
 * Sources real Jan–Mar 2026 data from the spreadsheet:
 *   - Account balances (end-of-March)
 *   - Income sources with actual monthly amounts
 *   - Budget config with real bill amounts + corrected due dates
 *   - Transactions for Jan, Feb, Mar 2026
 *
 * Usage:
 *   npm run seed          # run base seed first (creates tables + categories)
 *   npx tsx scripts/init-from-sheet.ts
 *
 * Transactions are tagged notes='seed' so they can be cleaned up after
 * Plaid imports real history (run: DELETE FROM transactions WHERE notes='seed').
 */

import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Credentials ───────────────────────────────────────────────────────────────
function readDevVars(): Record<string, string> {
  const contents = readFileSync(resolve(__dirname, '../.dev.vars'), 'utf-8');
  const result: Record<string, string> = {};
  for (const line of contents.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    result[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return result;
}

const vars = readDevVars();
const client = createClient({
  url:       vars['TURSO_DATABASE_URL'],
  authToken: vars['TURSO_AUTH_TOKEN'],
});

let txnCount = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

async function upsertTx(
  txId:   string,
  accountId: string,
  date:   string,
  amount: number,     // Plaid convention: positive = expense, negative = income
  merchantClean: string,
  categoryId:   string | null,
  entityId:     string,
) {
  await client.execute({
    sql: `
      INSERT OR IGNORE INTO transactions
        (id, account_id, date, amount, merchant_clean, merchant_raw,
         category_id, entity_id, is_recurring, is_pending, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'seed')
    `,
    args: [txId, accountId, date, amount, merchantClean, merchantClean,
           categoryId, entityId],
  });
  txnCount++;
}

// ── 1. Extra categories missed in base seed ───────────────────────────────────
console.log('\n[1/5] Patching categories…');
await client.execute(`
  INSERT OR IGNORE INTO categories (id, name, icon, color, entity_id)
  VALUES
    ('kennedy_hoa',    'Kennedy — HOA',        '🏢', '#fbcfe8', 'kennedy'),
    ('kirby_rent',     'Kirby — Rent Income',  '💵', '#4ade80', 'kirby'),
    ('kennedy_rent',   'Kennedy — Rent Income','💵', '#34d399', 'kennedy'),
    ('charity',        'Charity',              '❤️', '#f43f5e', 'household'),
    ('fitness',        'Fitness',              '🏋️', '#a3e635', 'household')
`);
console.log('✓ Categories patched');

// ── 2. Accounts ───────────────────────────────────────────────────────────────
// Balances = end of March 2026 (most recent completed month from spreadsheet)
console.log('\n[2/5] Creating accounts…');

const CHECKING_ID = 'seed_chase_checking';
const SAVINGS_ID  = 'seed_chase_savings';
const FIDELITY_ID = 'seed_fidelity';
const SAPPHIRE_ID = 'seed_sapphire_reserve';
const PRIME_ID    = 'seed_prime_visa';
const APPLE_ID    = 'seed_apple_card';

const accounts = [
  // id, name, type, subtype, current_balance, available_balance, entity_id
  [CHECKING_ID, 'Chase Checking',         'checking', 'checking',    4041.59,   4041.59,  'household'],
  [SAVINGS_ID,  'Chase Savings',          'savings',  'savings',     9000.00,   9000.00,  'household'],
  [FIDELITY_ID, 'Fidelity Investments',   'investment','brokerage',  71729.39,  null,     'household'],
  // CC balances: statement balance as of latest sheet update (row 100: CC Debt=3100.28)
  // Sapphire carries the bulk; Prime & Apple are lower-balance cards
  [SAPPHIRE_ID, 'Chase Sapphire Reserve', 'credit',   'credit card', 3100.28,   null,     'household'],
  [PRIME_ID,    'Chase Prime Visa',       'credit',   'credit card', 500.00,    null,     'household'],
  [APPLE_ID,    'Apple Card',             'credit',   'credit card', 100.00,    null,     'household'],
] as const;

for (const [aid, name, type, subtype, balance, avail, entity] of accounts) {
  await client.execute({
    sql: `
      INSERT INTO accounts
        (id, name, type, subtype, current_balance, available_balance, entity_id, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        current_balance   = excluded.current_balance,
        available_balance = excluded.available_balance,
        last_synced       = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    `,
    args: [aid, name, type, subtype, balance, avail ?? null, entity],
  });
}
console.log(`✓ ${accounts.length} accounts`);

// ── 3. Income sources — real 2026 amounts ─────────────────────────────────────
console.log('\n[3/5] Updating income sources…');

// Jan is a 3-paycheck month for Maham ($9,838). Standard months = $6,573.
// Alex standard = $8,038. Kirby rent = $3,500/mo. Kennedy rent not tracked here.
const incomeSources = [
  ['income_alex',         8038.00,  'monthly',  15],  // biweekly → ~2/mo, arrives mid-month
  ['income_maham',        6573.30,  'monthly',  1],   // standard month (Jan was $9,838 w/ bonus)
  ['income_kirby_rent',   3500.00,  'monthly',  1],
  ['income_kennedy_rent', 0,        'monthly',  1],   // update when Kennedy rent is confirmed
] as const;

for (const [sid, amount, frequency, expected_day] of incomeSources) {
  await client.execute({
    sql:  `UPDATE income_sources SET amount = ?, frequency = ?, expected_day = ? WHERE id = ?`,
    args: [amount, frequency, expected_day, sid],
  });
}
console.log('✓ Income sources updated');

// ── 4. Budget config — real bill amounts + corrected due dates ────────────────
console.log('\n[4/5] Updating budget config…');

// name, id, monthly_target, due_day, entity_id
// Amounts from Jan-Mar actuals; Kirby Mortgage due 12th (not 5th)
const billUpdates = [
  ['bill_kirby_mortgage',  2603.51, 12, 'kirby'],
  ['bill_kirby_hoa',        270.50,  5, 'kirby'],   // Jan was 345 (arrears), normalised to 270.50
  ['bill_chase_cc',        6000.00, 12, 'household'], // avg payment; varies monthly
  ['bill_nanny',           2802.00,  1, 'household'], // 3-month avg: (3415+2540+2692)/3 ≈ 2882, biweekly
  ['bill_cleaning',         426.67, 15, 'household'], // avg: (320+320+640)/3
  ['bill_internet_phone',   233.20, 30, 'household'], // avg: (142.28+175.33+382)/3
] as const;

for (const [bid, target, due, entity] of billUpdates) {
  await client.execute({
    sql:  `UPDATE budget_config SET monthly_target = ?, due_day = ?, entity_id = ? WHERE id = ?`,
    args: [target, due, entity, bid],
  });
}

// Add Kennedy bills (not in base seed)
await client.execute(`
  INSERT OR IGNORE INTO budget_config (id, name, category_id, monthly_target, due_day, is_recurring, entity_id)
  VALUES
    ('bill_kennedy_mortgage', 'Kennedy Mortgage', 'kennedy_mortgage', 4539.67, 1,  1, 'kennedy'),
    ('bill_kennedy_hoa',      'Kennedy HOA',      'kennedy_hoa',       575.00,  1,  1, 'kennedy')
`);

// Monthly spend targets updated to match spreadsheet reality
const spendUpdates = [
  ['budget_groceries',     600,  'household'],
  ['budget_dining',        400,  'household'],
  ['budget_subscriptions', 100,  'household'],
  ['budget_utilities',     320,  'household'],  // electricity + water + PIH avg
  ['budget_transport',     200,  'household'],  // gas avg
  ['budget_entertainment',  50,  'household'],
  ['budget_misc',         1000,  'household'],
] as const;

for (const [bid, target, entity] of spendUpdates) {
  await client.execute({
    sql:  `UPDATE budget_config SET monthly_target = ?, entity_id = ? WHERE id = ?`,
    args: [target, entity, bid],
  });
}
console.log('✓ Budget config updated');

// ── 5. Transactions Jan–Mar 2026 ──────────────────────────────────────────────
// Sign convention: positive = expense (money out), negative = income (money in).
// Matching Plaid's consumer account convention.
console.log('\n[5/5] Creating Jan–Mar transactions…');

type Month = { year: number; mo: string; label: string };
const months: Month[] = [
  { year: 2026, mo: '01', label: 'January'  },
  { year: 2026, mo: '02', label: 'February' },
  { year: 2026, mo: '03', label: 'March'    },
];

// ── Raw data keyed by month index (0=Jan,1=Feb,2=Mar) ────────────────────────
const incomeByMonth: [string, string, number, string, string][] = [
  // [month, date, amount (negative=income), merchant, category_id]
  // January
  ['01', '2026-01-03',  -9838.00, 'Maham Paycheck',  'income_salary'],
  ['01', '2026-01-03',  -8038.00, 'Alex Paycheck',   'income_salary'],
  ['01', '2026-01-01',  -3500.00, 'Kirby Rent',       'kirby_rent'],
  // February
  ['02', '2026-02-03',  -6573.30, 'Maham Paycheck',  'income_salary'],
  ['02', '2026-02-03',  -8038.00, 'Alex Paycheck',   'income_salary'],
  ['02', '2026-02-01',  -3500.00, 'Kirby Rent',       'kirby_rent'],
  // March
  ['03', '2026-03-03',  -6571.32, 'Maham Paycheck',  'income_salary'],
  ['03', '2026-03-03',  -8027.48, 'Alex Paycheck',   'income_salary'],
  ['03', '2026-03-01',  -3500.00, 'Kirby Rent',       'kirby_rent'],
];

// ── Fixed bills from checking account ─────────────────────────────────────────
// [mo, date, amount, merchant, category_id, entity_id, accountId]
type BillRow = [string, string, number, string, string, string, string];
const bills: BillRow[] = [
  // January
  ['01','2026-01-05',  345.00,   'Kirby HOA',          'kirby_hoa',          'kirby',     CHECKING_ID],
  ['01','2026-01-12', 2603.51,   'Kirby Mortgage',     'kirby_mortgage',     'kirby',     CHECKING_ID],
  ['01','2026-01-01', 4539.67,   'Kennedy Mortgage',   'kennedy_mortgage',   'kennedy',   CHECKING_ID],
  ['01','2026-01-01',  575.00,   'Kennedy HOA',        'kennedy_hoa',        'kennedy',   CHECKING_ID],
  ['01','2026-01-15', 3415.00,   'Nanny',              'nanny',              'household', CHECKING_ID],
  ['01','2026-01-15',  320.00,   'House Cleaning',     'cleaning',           'household', CHECKING_ID],
  ['01','2026-01-30',  142.28,   'AT&T Phone/Internet','internet_phone',     'household', CHECKING_ID],
  ['01','2026-01-12', 7532.01,   'Chase CC Payment',   'cc_payment',         'household', CHECKING_ID],
  ['01','2026-01-15',  100.00,   'Chase Savings Transfer','savings',         'household', CHECKING_ID],
  // February
  ['02','2026-02-05',  270.50,   'Kirby HOA',          'kirby_hoa',          'kirby',     CHECKING_ID],
  ['02','2026-02-12', 2603.51,   'Kirby Mortgage',     'kirby_mortgage',     'kirby',     CHECKING_ID],
  ['02','2026-02-01', 4539.67,   'Kennedy Mortgage',   'kennedy_mortgage',   'kennedy',   CHECKING_ID],
  ['02','2026-02-15', 2540.00,   'Nanny',              'nanny',              'household', CHECKING_ID],
  ['02','2026-02-15',  320.00,   'House Cleaning',     'cleaning',           'household', CHECKING_ID],
  ['02','2026-02-28',  175.33,   'AT&T Phone/Internet','internet_phone',     'household', CHECKING_ID],
  ['02','2026-02-12', 7303.88,   'Chase CC Payment',   'cc_payment',         'household', CHECKING_ID],
  ['02','2026-02-15', 2000.00,   'Chase Savings Transfer','savings',         'household', CHECKING_ID],
  // March
  ['03','2026-03-05',  270.50,   'Kirby HOA',          'kirby_hoa',          'kirby',     CHECKING_ID],
  ['03','2026-03-12', 2603.51,   'Kirby Mortgage',     'kirby_mortgage',     'kirby',     CHECKING_ID],
  ['03','2026-03-01', 4539.67,   'Kennedy Mortgage',   'kennedy_mortgage',   'kennedy',   CHECKING_ID],
  ['03','2026-03-15', 2692.00,   'Nanny',              'nanny',              'household', CHECKING_ID],
  ['03','2026-03-15',  640.00,   'House Cleaning',     'cleaning',           'household', CHECKING_ID],
  ['03','2026-03-30',  382.00,   'AT&T Phone/Internet','internet_phone',     'household', CHECKING_ID],
  ['03','2026-03-12', 4818.16,   'Chase CC Payment',   'cc_payment',         'household', CHECKING_ID],
];

// ── CC Recurring subscriptions (charged to Sapphire unless noted) ─────────────
type SubRow = [string, string, number, string, string, string];
const subscriptions: SubRow[] = [
  // January
  ['01','2026-01-05',   9.99, 'iCloud',           'subscriptions', SAPPHIRE_ID],
  ['01','2026-01-05',  18.39, 'Spotify',          'subscriptions', SAPPHIRE_ID],
  ['01','2026-01-08',   5.31, 'Google Storage',   'subscriptions', SAPPHIRE_ID],
  ['01','2026-01-17', 116.67, 'Electricity',      'utilities',     SAPPHIRE_ID],
  ['01','2026-01-17',  21.40, 'PIH Health',       'utilities',     SAPPHIRE_ID],
  ['01','2026-01-17',  47.63, 'Peloton',          'fitness',       SAPPHIRE_ID],
  ['01','2026-01-24',  60.00, 'Gas Station',      'transport',     SAPPHIRE_ID],
  ['01','2026-01-25', 171.00, 'Water Bill',       'utilities',     SAPPHIRE_ID],
  ['01','2026-01-23',  21.28, 'ChatGPT',          'subscriptions', SAPPHIRE_ID],
  ['01','2026-01-25',  35.71, 'Hulu',             'subscriptions', SAPPHIRE_ID],
  ['01','2026-01-28',  52.44, 'Unrwa Donation',   'charity',       SAPPHIRE_ID],
  // February
  ['02','2026-02-05',   9.99, 'iCloud',           'subscriptions', SAPPHIRE_ID],
  ['02','2026-02-05',  18.39, 'Spotify',          'subscriptions', SAPPHIRE_ID],
  ['02','2026-02-08',   5.31, 'Google Storage',   'subscriptions', SAPPHIRE_ID],
  ['02','2026-02-17', 125.85, 'Electricity',      'utilities',     SAPPHIRE_ID],
  ['02','2026-02-17',  21.40, 'PIH Health',       'utilities',     SAPPHIRE_ID],
  ['02','2026-02-17',  54.11, 'Peloton',          'fitness',       SAPPHIRE_ID],
  ['02','2026-02-24', 174.92, 'Gas Station',      'transport',     SAPPHIRE_ID],
  ['02','2026-02-25', 143.00, 'Water Bill',       'utilities',     SAPPHIRE_ID],
  ['02','2026-02-23',  21.28, 'ChatGPT',          'subscriptions', SAPPHIRE_ID],
  ['02','2026-02-25',  35.71, 'Hulu',             'subscriptions', SAPPHIRE_ID],
  ['02','2026-02-28',  52.44, 'Unrwa Donation',   'charity',       SAPPHIRE_ID],
  ['02','2026-02-15',   4.26, 'New York Times',   'subscriptions', SAPPHIRE_ID],
  // March
  ['03','2026-03-05',   9.99, 'iCloud',           'subscriptions', SAPPHIRE_ID],
  ['03','2026-03-05',  18.39, 'Spotify',          'subscriptions', SAPPHIRE_ID],
  ['03','2026-03-08',   5.31, 'Google Storage',   'subscriptions', SAPPHIRE_ID],
  ['03','2026-03-17', 102.52, 'Electricity',      'utilities',     SAPPHIRE_ID],
  ['03','2026-03-17',  21.40, 'PIH Health',       'utilities',     SAPPHIRE_ID],
  ['03','2026-03-17',  54.11, 'Peloton',          'fitness',       SAPPHIRE_ID],
  ['03','2026-03-24', 209.72, 'Gas Station',      'transport',     SAPPHIRE_ID],
  ['03','2026-03-25', 143.04, 'Water Bill',       'utilities',     SAPPHIRE_ID],
  ['03','2026-03-23',  21.28, 'ChatGPT',          'subscriptions', SAPPHIRE_ID],
  ['03','2026-03-25',  35.71, 'Hulu',             'subscriptions', SAPPHIRE_ID],
  ['03','2026-03-28',  52.44, 'Unrwa Donation',   'charity',       SAPPHIRE_ID],
  ['03','2026-03-15',   4.26, 'New York Times',   'subscriptions', SAPPHIRE_ID],
  ['03','2026-03-25',  21.64, 'Canva',            'subscriptions', SAPPHIRE_ID],
];

// ── CC General spend (what's left after known subscriptions, split across cards)
// Total CC spend - subscriptions = general (groceries, dining, shopping, etc.)
// Jan: 8091.83 - 559.82 = 7532.01
// Feb: 7966.28 - 662.40 = 7303.88
// Mar: 5517.97 - 699.81 = 4818.16
//
// Split estimate: ~40% groceries, 30% dining, 30% misc shopping
type GeneralRow = [string, string, number, string, string, string];
const generalCC: GeneralRow[] = [
  // Jan — Sapphire general
  ['01','2026-01-20', 2100.00, 'Groceries (Sapphire)',   'groceries',  SAPPHIRE_ID],
  ['01','2026-01-20', 1600.00, 'Dining Out (Sapphire)',  'dining',     SAPPHIRE_ID],
  ['01','2026-01-20', 1530.34, 'Shopping (Sapphire)',    'miscellaneous', SAPPHIRE_ID],
  ['01','2026-01-20', 1050.67, 'Other (Sapphire)',       'miscellaneous', SAPPHIRE_ID],
  // Jan — Prime general ($1491.27 total)
  ['01','2026-01-20',  600.00, 'Amazon Prime Orders',    'miscellaneous', PRIME_ID],
  ['01','2026-01-20',  500.00, 'Groceries (Prime)',      'groceries',  PRIME_ID],
  ['01','2026-01-20',  391.27, 'Other (Prime)',          'miscellaneous', PRIME_ID],
  // Jan — Apple Card ($202.56)
  ['01','2026-01-20',  202.56, 'Apple Card Charges',     'miscellaneous', APPLE_ID],

  // Feb — Sapphire general ($7012 - 662.40 subs distributed above = ~6349.60 + 662.40 = see note)
  // Sapphire total = 7012; subs = 662.40 → general = 6349.60
  ['02','2026-02-20', 2100.00, 'Groceries (Sapphire)',   'groceries',  SAPPHIRE_ID],
  ['02','2026-02-20', 1800.00, 'Dining Out (Sapphire)',  'dining',     SAPPHIRE_ID],
  ['02','2026-02-20', 2449.60, 'Shopping (Sapphire)',    'miscellaneous', SAPPHIRE_ID],
  // Feb — Prime ($606.23)
  ['02','2026-02-20',  350.00, 'Amazon Prime Orders',    'miscellaneous', PRIME_ID],
  ['02','2026-02-20',  256.23, 'Other (Prime)',          'miscellaneous', PRIME_ID],
  // Feb — Apple Card ($348.05)
  ['02','2026-02-20',  348.05, 'Apple Card Charges',     'miscellaneous', APPLE_ID],

  // Mar — Sapphire general ($4614.57 total; subs 699.81 → general = 3914.76)
  ['03','2026-03-20', 1500.00, 'Groceries (Sapphire)',   'groceries',  SAPPHIRE_ID],
  ['03','2026-03-20', 1200.00, 'Dining Out (Sapphire)',  'dining',     SAPPHIRE_ID],
  ['03','2026-03-20', 1214.76, 'Shopping (Sapphire)',    'miscellaneous', SAPPHIRE_ID],
  // Mar — Prime ($876.16)
  ['03','2026-03-20',  500.00, 'Amazon Prime Orders',    'miscellaneous', PRIME_ID],
  ['03','2026-03-20',  376.16, 'Other (Prime)',          'miscellaneous', PRIME_ID],
  // Mar — Apple Card ($27.24)
  ['03','2026-03-20',   27.24, 'Apple Card Charges',     'miscellaneous', APPLE_ID],
];

// ── Insert income ─────────────────────────────────────────────────────────────
for (const [mo, date, amount, merchant, catId] of incomeByMonth) {
  const entity = catId === 'kirby_rent' ? 'kirby' : 'household';
  const acct   = catId === 'kirby_rent' ? CHECKING_ID : CHECKING_ID;
  await upsertTx(`seed_inc_${mo}_${merchant.replace(/\s/g,'_')}`, acct, date, amount, merchant, catId, entity);
}

// ── Insert fixed bills ────────────────────────────────────────────────────────
for (const [mo, date, amount, merchant, catId, entity, acct] of bills) {
  await upsertTx(`seed_bill_${mo}_${merchant.replace(/\s/g,'_')}`, acct, date, amount, merchant, catId, entity);
}

// ── Insert subscriptions ──────────────────────────────────────────────────────
let subIdx = 0;
for (const [mo, date, amount, merchant, catId, acct] of subscriptions) {
  await upsertTx(`seed_sub_${mo}_${String(subIdx++).padStart(3,'0')}`, acct, date, amount, merchant, catId, 'household');
}

// ── Insert CC general spend ───────────────────────────────────────────────────
let genIdx = 0;
for (const [mo, date, amount, merchant, catId, acct] of generalCC) {
  await upsertTx(`seed_cc_${mo}_${String(genIdx++).padStart(3,'0')}`, acct, date, amount, merchant, catId, 'household');
}

client.close();
console.log(`\n✅  Init complete — ${txnCount} transactions inserted`);
console.log('\nNext steps:');
console.log('  1. npm run dev → http://localhost:4321');
console.log('  2. Go to /connect to link Chase via Plaid');
console.log('  3. After Plaid syncs, clean up seed data:');
console.log("       DELETE FROM transactions WHERE notes = 'seed'");
console.log('  4. Update income_sources.amount for Kennedy rent when confirmed');
