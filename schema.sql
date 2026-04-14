-- Pocket Finance — Turso / libSQL Schema
-- Run via: npx tsx scripts/seed.ts
-- ───────────────────────────────────────────────────────────────

-- Key/value configuration store (password hash, session, feature flags)
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- ───────── Plaid items (one per bank connection) ─────────────────
CREATE TABLE IF NOT EXISTS plaid_items (
    id               TEXT PRIMARY KEY,   -- Plaid item_id
    access_token     TEXT NOT NULL,      -- Plaid access_token (sensitive)
    institution_id   TEXT,
    institution_name TEXT,
    cursor           TEXT,               -- transactions/sync cursor
    last_synced      TEXT,
    created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ───────── Accounts (synced from Plaid) ──────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
    id               TEXT PRIMARY KEY,   -- Plaid account_id
    plaid_item_id    TEXT REFERENCES plaid_items(id),
    name             TEXT NOT NULL,
    official_name    TEXT,
    type             TEXT CHECK(type IN ('credit','checking','savings','investment','loan')),
    subtype          TEXT,               -- 'checking', 'savings', 'credit card'
    current_balance  REAL DEFAULT 0,
    available_balance REAL,
    currency_code    TEXT DEFAULT 'USD',
    entity_id        TEXT DEFAULT 'household', -- 'household' | 'kirby' | 'kennedy'
    is_active        INTEGER DEFAULT 1,
    last_synced      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ───────── Categories ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    icon      TEXT,           -- emoji or icon name
    color     TEXT,           -- hex color for UI
    parent_id TEXT REFERENCES categories(id),
    entity_id TEXT DEFAULT 'household'  -- which entity this category belongs to
);

-- ───────── Budget configuration (monthly targets + due dates) ────
CREATE TABLE IF NOT EXISTS budget_config (
    id                 TEXT PRIMARY KEY,
    category_id        TEXT REFERENCES categories(id),
    name               TEXT NOT NULL,
    monthly_target     REAL,
    due_day            INTEGER,          -- day of month bill is due (1–31)
    is_recurring       INTEGER DEFAULT 0,
    entity_id          TEXT DEFAULT 'household',
    funding_account_id TEXT REFERENCES accounts(id),
    created_at         TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ───────── Transactions (cleansed ledger) ────────────────────────
-- Plaid convention: positive amount = money leaving (debit/expense),
--                   negative amount = money arriving (credit/income)
CREATE TABLE IF NOT EXISTS transactions (
    id               TEXT PRIMARY KEY,   -- Plaid transaction_id
    account_id       TEXT REFERENCES accounts(id),
    date             TEXT NOT NULL,      -- YYYY-MM-DD (posted date)
    authorized_date  TEXT,
    amount           REAL NOT NULL,
    merchant_raw     TEXT,
    merchant_clean   TEXT,
    category_id      TEXT REFERENCES categories(id),
    entity_id        TEXT DEFAULT 'household',
    is_recurring     INTEGER DEFAULT 0,
    is_pending       INTEGER DEFAULT 0,
    is_cleared       INTEGER DEFAULT 1,
    is_hidden        INTEGER DEFAULT 0,  -- soft-delete for UI
    notes            TEXT,
    created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ───────── Merchant normalisation rules ──────────────────────────
CREATE TABLE IF NOT EXISTS merchant_rules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern       TEXT NOT NULL,   -- substring match (case-insensitive)
    merchant_clean TEXT NOT NULL,
    category_id   TEXT REFERENCES categories(id),
    entity_id     TEXT,            -- null = any entity
    priority      INTEGER DEFAULT 0
);

-- ───────── Expected income sources ───────────────────────────────
CREATE TABLE IF NOT EXISTS income_sources (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,   -- 'Alex Salary', 'Kirby Rent', etc.
    amount        REAL NOT NULL,   -- expected monthly amount
    frequency     TEXT CHECK(frequency IN ('monthly','biweekly','weekly','annual','one-time')),
    expected_day  INTEGER,         -- day of month expected to arrive
    entity_id     TEXT DEFAULT 'household',
    is_active     INTEGER DEFAULT 1
);

-- ───────── Indexes ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_transactions_date        ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_account     ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_category    ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_transactions_entity      ON transactions(entity_id);
CREATE INDEX IF NOT EXISTS idx_transactions_pending     ON transactions(is_pending);
