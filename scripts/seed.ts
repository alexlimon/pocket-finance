/**
 * pocket-finance — Database seed script
 *
 * Usage:
 *   cp .dev.vars.example .dev.vars   # fill in Turso credentials
 *   npm run seed
 *
 * This script:
 *   1. Creates all tables (idempotent — uses CREATE TABLE IF NOT EXISTS)
 *   2. Seeds categories, budget config, income sources, and merchant rules
 *      that match your 2026 budget spreadsheet
 */

import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Read credentials from .dev.vars ─────────────────────────────────────────
function readDevVars(): Record<string, string> {
  try {
    const contents = readFileSync(resolve(__dirname, '../.dev.vars'), 'utf-8');
    const result: Record<string, string> = {};
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    }
    return result;
  } catch {
    console.error('❌  Could not read .dev.vars — copy .dev.vars.example and fill in your values.');
    process.exit(1);
  }
}

const vars = readDevVars();
const TURSO_DATABASE_URL = vars['TURSO_DATABASE_URL'];
const TURSO_AUTH_TOKEN   = vars['TURSO_AUTH_TOKEN'];

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  console.error('❌  TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set in .dev.vars');
  process.exit(1);
}

const client = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

// ── Create tables ─────────────────────────────────────────────────────────────
const schema = readFileSync(resolve(__dirname, '../schema.sql'), 'utf-8');

console.log('Creating tables…');
// Execute each statement individually (Turso doesn't support multi-statement execute)
for (const stmt of schema.split(';').map(s => s.trim()).filter(s => s.length > 0)) {
  await client.execute(stmt);
}
console.log('✓ Tables ready');

// ── Helper ────────────────────────────────────────────────────────────────────
async function upsert(table: string, idCol: string, id: string, fields: Record<string, unknown>) {
  const cols   = [idCol, ...Object.keys(fields)];
  const vals   = [id,    ...Object.values(fields)];
  const placeholders = vals.map(() => '?').join(', ');
  const updates = Object.keys(fields).map(k => `${k} = excluded.${k}`).join(', ');

  await client.execute({
    sql:  `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
           ON CONFLICT(${idCol}) DO UPDATE SET ${updates}`,
    args: vals,
  });
}

// ── Categories ────────────────────────────────────────────────────────────────
console.log('\nSeeding categories…');

const categories: [string, string, string, string][] = [
  // [id, name, icon, color]
  // Household
  ['housing',         'Housing',              '🏠', '#60a5fa'],
  ['groceries',       'Groceries',            '🛒', '#4ade80'],
  ['dining',          'Dining Out',           '🍽️', '#f97316'],
  ['coffee',          'Coffee',               '☕', '#a78bfa'],
  ['transport',       'Transportation',       '🚗', '#facc15'],
  ['kids',            'Kids & Family',        '👶', '#f472b6'],
  ['nanny',           'Nanny',                '👩‍👧', '#fb923c'],
  ['healthcare',      'Healthcare',           '💊', '#2dd4bf'],
  ['personal_care',   'Personal Care',        '✂️', '#e879f9'],
  ['clothing',        'Clothing',             '👕', '#818cf8'],
  ['entertainment',   'Entertainment',        '🎬', '#f43f5e'],
  ['subscriptions',   'Subscriptions',        '📱', '#94a3b8'],
  ['utilities',       'Utilities',            '💡', '#fbbf24'],
  ['internet_phone',  'Internet & Phone',     '📡', '#38bdf8'],
  ['cleaning',        'House Cleaning',       '🧹', '#86efac'],
  ['insurance',       'Insurance (Personal)', '🛡️', '#c4b5fd'],
  ['miscellaneous',   'Miscellaneous',        '📦', '#6b7280'],
  ['cc_payment',      'Credit Card Payment',  '💳', '#64748b'],
  ['savings',         'Savings Transfer',     '🏦', '#4ade80'],
  // Income
  ['income_salary',   'Salary',               '💰', '#4ade80'],
  ['income_rental',   'Rental Income',        '🏘️', '#34d399'],
  // Kirby property
  ['kirby_mortgage',   'Kirby — Mortgage',    '🏡', '#60a5fa'],
  ['kirby_hoa',        'Kirby — HOA',         '🏢', '#93c5fd'],
  ['kirby_insurance',  'Kirby — Insurance',   '🛡️', '#bfdbfe'],
  ['kirby_utilities',  'Kirby — Utilities',   '💡', '#dbeafe'],
  ['kirby_maintenance','Kirby — Maintenance', '🔧', '#e0e7ff'],
  // Kennedy property
  ['kennedy_mortgage',   'Kennedy — Mortgage',    '🏡', '#f472b6'],
  ['kennedy_insurance',  'Kennedy — Insurance',   '🛡️', '#fbcfe8'],
  ['kennedy_maintenance','Kennedy — Maintenance', '🔧', '#fce7f3'],
];

for (const [id, name, icon, color] of categories) {
  const entity = id.startsWith('kirby') ? 'kirby' : id.startsWith('kennedy') ? 'kennedy' : 'household';
  await upsert('categories', 'id', id, { name, icon, color, entity_id: entity });
}
console.log(`✓ ${categories.length} categories`);

// ── Budget configuration ──────────────────────────────────────────────────────
console.log('\nSeeding budget config…');

// Recurring bills (matching the 2026 spreadsheet)
const bills: [string, string, string, number, number, string][] = [
  // [id, name, category_id, monthly_target, due_day, entity_id]
  ['bill_kirby_mortgage',  'Kirby Mortgage',    'kirby_mortgage',  0,    5,  'kirby'],
  ['bill_kirby_hoa',       'Kirby HOA',         'kirby_hoa',       0,    5,  'kirby'],
  ['bill_kirby_insurance', 'Kirby Insurance',   'kirby_insurance', 0,    1,  'kirby'],
  ['bill_chase_cc',        'Chase CC Payment',  'cc_payment',      0,    12, 'household'],
  ['bill_nanny',           'Nanny',             'nanny',           0,    15, 'household'],
  ['bill_cleaning',        'House Cleaning',    'cleaning',        0,    1,  'household'],
  ['bill_internet_phone',  'Internet & Phone',  'internet_phone',  0,    30, 'household'],
];

for (const [id, name, category_id, monthly_target, due_day, entity_id] of bills) {
  await upsert('budget_config', 'id', id, {
    name, category_id, monthly_target, due_day, is_recurring: 1, entity_id,
  });
}

// Monthly spending targets (non-recurring)
const targets: [string, string, string, number, string][] = [
  // [id, name, category_id, monthly_target, entity_id]
  ['budget_groceries',    'Groceries',          'groceries',      800,  'household'],
  ['budget_dining',       'Dining Out',         'dining',         400,  'household'],
  ['budget_coffee',       'Coffee',             'coffee',         80,   'household'],
  ['budget_transport',    'Transportation',     'transport',      300,  'household'],
  ['budget_kids',         'Kids & Family',      'kids',           200,  'household'],
  ['budget_healthcare',   'Healthcare',         'healthcare',     200,  'household'],
  ['budget_personal',     'Personal Care',      'personal_care',  150,  'household'],
  ['budget_clothing',     'Clothing',           'clothing',       150,  'household'],
  ['budget_entertainment','Entertainment',      'entertainment',  200,  'household'],
  ['budget_subscriptions','Subscriptions',      'subscriptions',  100,  'household'],
  ['budget_utilities',    'Utilities',          'utilities',      200,  'household'],
  ['budget_misc',         'Miscellaneous',      'miscellaneous',  150,  'household'],
];

for (const [id, name, category_id, monthly_target, entity_id] of targets) {
  await upsert('budget_config', 'id', id, {
    name, category_id, monthly_target, due_day: null, is_recurring: 0, entity_id,
  });
}

console.log(`✓ ${bills.length + targets.length} budget entries`);

// ── Income sources ────────────────────────────────────────────────────────────
console.log('\nSeeding income sources…');

const incomeSources: [string, string, number, string, number | null, string][] = [
  // [id, name, amount, frequency, expected_day, entity_id]
  ['income_alex',           'Alex — Salary',     0,    'monthly',   1,  'household'],
  ['income_maham',          'Maham — Salary',    0,    'monthly',   15, 'household'],
  ['income_kirby_rent',     'Kirby Rent',        0,    'monthly',   1,  'kirby'],
  ['income_kennedy_rent',   'Kennedy Rent',      0,    'monthly',   1,  'kennedy'],
];

for (const [id, name, amount, frequency, expected_day, entity_id] of incomeSources) {
  await upsert('income_sources', 'id', id, {
    name, amount, frequency, expected_day, entity_id, is_active: 1,
  });
}
console.log(`✓ ${incomeSources.length} income sources`);

// ── Merchant rules ────────────────────────────────────────────────────────────
console.log('\nSeeding merchant rules…');

// Clear existing rules and re-insert
await client.execute('DELETE FROM merchant_rules');

const rules: [string, string, string | null, string | null, number][] = [
  // [pattern, merchant_clean, category_id, entity_id, priority]
  // Food & Drink
  ['starbucks',     'Starbucks',       'coffee',       null, 10],
  ['dunkin',        'Dunkin\'',        'coffee',       null, 10],
  ['chipotle',      'Chipotle',        'dining',       null, 10],
  ['mcdonald',      'McDonald\'s',     'dining',       null, 10],
  ['doordash',      'DoorDash',        'dining',       null, 10],
  ['ubereats',      'Uber Eats',       'dining',       null, 10],
  ['grubhub',       'Grubhub',         'dining',       null, 10],
  ['instacart',     'Instacart',       'groceries',    null, 10],
  ['whole foods',   'Whole Foods',     'groceries',    null, 10],
  ['h-e-b',         'H-E-B',           'groceries',    null, 10],
  ['kroger',        'Kroger',          'groceries',    null, 10],
  ['walmart',       'Walmart',         'groceries',    null, 10],
  ['costco',        'Costco',          'groceries',    null, 10],
  ['trader joe',    'Trader Joe\'s',   'groceries',    null, 10],
  ['amazon fresh',  'Amazon Fresh',    'groceries',    null, 10],
  // Transport
  ['shell',         'Shell',           'transport',    null, 5],
  ['exxon',         'ExxonMobil',      'transport',    null, 5],
  ['chevron',       'Chevron',         'transport',    null, 5],
  ['uber',          'Uber',            'transport',    null, 5],
  ['lyft',          'Lyft',            'transport',    null, 5],
  // Subscriptions
  ['netflix',       'Netflix',         'subscriptions', null, 10],
  ['spotify',       'Spotify',         'subscriptions', null, 10],
  ['apple',         'Apple',           'subscriptions', null, 8],
  ['amazon prime',  'Amazon Prime',    'subscriptions', null, 10],
  ['hulu',          'Hulu',            'subscriptions', null, 10],
  ['disney',        'Disney+',         'subscriptions', null, 10],
  ['youtube',       'YouTube Premium', 'subscriptions', null, 10],
  // Healthcare
  ['cvs',           'CVS Pharmacy',    'healthcare',   null, 10],
  ['walgreens',     'Walgreens',       'healthcare',   null, 10],
  // Utilities
  ['at&t',          'AT&T',            'internet_phone', null, 10],
  ['verizon',       'Verizon',         'internet_phone', null, 10],
  ['t-mobile',      'T-Mobile',        'internet_phone', null, 10],
  ['xfinity',       'Xfinity',         'internet_phone', null, 10],
  ['spectrum',      'Spectrum',        'internet_phone', null, 10],
  // Credit card payments (not expenses)
  ['chase card',    'Chase CC Payment','cc_payment',   null, 20],
  ['autopay',       'CC Autopay',      'cc_payment',   null, 15],
];

for (const [pattern, merchant_clean, category_id, entity_id, priority] of rules) {
  await client.execute({
    sql:  `INSERT INTO merchant_rules (pattern, merchant_clean, category_id, entity_id, priority) VALUES (?, ?, ?, ?, ?)`,
    args: [pattern, merchant_clean, category_id, entity_id, priority],
  });
}
console.log(`✓ ${rules.length} merchant rules`);

// ── Done ──────────────────────────────────────────────────────────────────────
client.close();
console.log('\n✅  Seed complete. Next steps:');
console.log('   1. Update income amounts in income_sources (amount column)');
console.log('   2. Update bill amounts in budget_config (monthly_target column)');
console.log('   3. Go to /connect to link your Chase accounts via Plaid');
console.log('   4. npm run dev  →  http://localhost:4321');
