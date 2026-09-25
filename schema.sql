-- =====================================================================
--  MONEYLENDER APP  -  STEP 1: DATABASE SCHEMA  (SQLite)
-- =====================================================================
--  Design rules that keep data safe:
--   1. Money is stored as INTEGER PAISE (Rs 1 = 100 paise). No decimal
--      rounding errors, ever. The app converts to/from rupees.
--   2. Nothing is ever hard-deleted. Records are "archived" or "voided"
--      so a wrong click can always be undone.
--   3. Every edit/delete is written to audit_log with the old and new
--      values, so the full history of every change is kept.
--   4. Balances are NOT stored by hand. They are calculated from the
--      transactions ledger, so they can never go out of sync.
-- =====================================================================

PRAGMA foreign_keys = ON;      -- enforce links between tables
PRAGMA journal_mode = WAL;     -- crash-safe writes, no half-saved data

-- ---------------------------------------------------------------------
-- 1. USERS  (login system; your father is the main/admin user)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT    NOT NULL UNIQUE,
    password_hash   TEXT    NOT NULL,              -- bcrypt hash, never plain text
    full_name       TEXT    NOT NULL,
    role            TEXT    NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','staff')),
    is_active       INTEGER NOT NULL DEFAULT 1,
    last_login_at   TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- 2. BORROWERS  (every customer and their details)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS borrowers (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name           TEXT    NOT NULL,
    father_or_spouse    TEXT,
    phone               TEXT,
    alt_phone           TEXT,
    email               TEXT,
    address             TEXT,
    city                TEXT,
    occupation          TEXT,
    id_proof_type       TEXT,                      -- Aadhaar / PAN / Voter ID ...
    id_proof_number     TEXT,
    guarantor_name      TEXT,
    guarantor_phone     TEXT,
    guarantor_address   TEXT,
    collateral_details  TEXT,                      -- gold, land papers, cheque, etc.
    photo_path          TEXT,
    notes               TEXT,
    is_archived         INTEGER NOT NULL DEFAULT 0,  -- archive instead of delete
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_borrowers_name  ON borrowers(full_name);
CREATE INDEX IF NOT EXISTS idx_borrowers_phone ON borrowers(phone);

-- ---------------------------------------------------------------------
-- 3. LOANS  (one row = one loan CYCLE of a borrower)
--    A borrower can have many cycles over time. When a cycle is closed
--    and a new one starts, cycle_number goes 1 -> 2 -> 3 ...
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loans (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    borrower_id         INTEGER NOT NULL REFERENCES borrowers(id),
    cycle_number        INTEGER NOT NULL DEFAULT 1,
    start_date          TEXT    NOT NULL,          -- YYYY-MM-DD

    -- Interest settings (fully editable per loan)
    interest_rate       REAL    NOT NULL,          -- e.g. 2.0 means 2%
    rate_period         TEXT    NOT NULL DEFAULT 'monthly'
                        CHECK (rate_period IN ('daily','monthly','yearly')),
    interest_type       TEXT    NOT NULL DEFAULT 'simple'
                        CHECK (interest_type IN ('simple','compound')),

    -- Due-date settings (drive the home-page reminders)
    payment_frequency   TEXT    NOT NULL DEFAULT 'monthly'
                        CHECK (payment_frequency IN ('daily','weekly','monthly','custom')),
    next_due_date       TEXT,                      -- next date payment is expected
    expected_amount     INTEGER,                   -- optional expected payment (paise)

    status              TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','closed','defaulted')),
    closed_date         TEXT,
    notes               TEXT,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (borrower_id, cycle_number)
);
CREATE INDEX IF NOT EXISTS idx_loans_borrower ON loans(borrower_id);
CREATE INDEX IF NOT EXISTS idx_loans_status   ON loans(status);
CREATE INDEX IF NOT EXISTS idx_loans_due      ON loans(next_due_date);

-- ---------------------------------------------------------------------
-- 4. TRANSACTIONS  (the ledger: every rupee in or out is one row)
--    disbursement      -> money given at the start of a cycle
--    topup             -> extra money given later (adds to principal)
--    principal_payment -> borrower repays principal
--    interest_payment  -> borrower pays interest
--    Wrong entry? Set is_voided = 1 (row is kept, ignored in totals).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_id         INTEGER NOT NULL REFERENCES loans(id),
    type            TEXT    NOT NULL
                    CHECK (type IN ('disbursement','topup','principal_payment','interest_payment')),
    amount          INTEGER NOT NULL CHECK (amount > 0),   -- in paise
    txn_date        TEXT    NOT NULL,                      -- YYYY-MM-DD
    method          TEXT    DEFAULT 'cash'
                    CHECK (method IN ('cash','upi','bank_transfer','cheque','other')),
    reference_no    TEXT,                                  -- UPI ref / cheque no.
    interest_from   TEXT,                                  -- for interest_payment: period start
    interest_to     TEXT,                                  -- for interest_payment: period end
    note            TEXT,
    is_voided       INTEGER NOT NULL DEFAULT 0,
    voided_reason   TEXT,
    created_by      INTEGER REFERENCES users(id),
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_loan ON transactions(loan_id);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(txn_date);

-- ---------------------------------------------------------------------
-- 5. REMINDERS  (custom notes/alerts your father can add himself,
--    e.g. "Ask Ramesh about the pending cheque")
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    borrower_id     INTEGER REFERENCES borrowers(id),
    loan_id         INTEGER REFERENCES loans(id),
    title           TEXT    NOT NULL,
    details         TEXT,
    remind_on       TEXT    NOT NULL,              -- YYYY-MM-DD
    is_done         INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reminders_date ON reminders(remind_on);

-- ---------------------------------------------------------------------
-- 6. SETTINGS  (editable from inside the app: business name, currency,
--    default interest rate, reminder lead days, theme, etc.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES
    ('business_name',          'My Lending Business'),
    ('currency_symbol',        'Rs'),
    ('default_interest_rate',  '2'),
    ('default_rate_period',    'monthly'),
    ('reminder_days_before',   '0'),
    ('theme',                  'dark');

-- ---------------------------------------------------------------------
-- 7. AUDIT LOG  (permanent history of every change; never edited)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id),
    table_name  TEXT    NOT NULL,
    record_id   INTEGER NOT NULL,
    action      TEXT    NOT NULL CHECK (action IN ('create','update','archive','void','restore')),
    old_data    TEXT,                              -- JSON snapshot before
    new_data    TEXT,                              -- JSON snapshot after
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_log(table_name, record_id);

-- ---------------------------------------------------------------------
-- 8. AUTO-UPDATE "updated_at" whenever a row is edited
-- ---------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_users_updated        AFTER UPDATE ON users
BEGIN UPDATE users        SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_borrowers_updated    AFTER UPDATE ON borrowers
BEGIN UPDATE borrowers    SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_loans_updated        AFTER UPDATE ON loans
BEGIN UPDATE loans        SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_transactions_updated AFTER UPDATE ON transactions
BEGIN UPDATE transactions SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_reminders_updated    AFTER UPDATE ON reminders
BEGIN UPDATE reminders    SET updated_at = datetime('now') WHERE id = NEW.id; END;

-- ---------------------------------------------------------------------
-- 9. AUDIT PROTECTION: audit_log rows can never be changed or deleted
-- ---------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is read-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is read-only'); END;

-- ---------------------------------------------------------------------
-- 10. LOAN SUMMARY VIEW  (balances calculated live from the ledger)
-- ---------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS loan_summary AS
SELECT
    l.id                                             AS loan_id,
    l.borrower_id,
    l.cycle_number,
    l.status,
    l.next_due_date,
    COALESCE(SUM(CASE WHEN t.type IN ('disbursement','topup')
                      AND t.is_voided = 0 THEN t.amount END), 0)  AS total_lent,
    COALESCE(SUM(CASE WHEN t.type = 'principal_payment'
                      AND t.is_voided = 0 THEN t.amount END), 0)  AS principal_repaid,
    COALESCE(SUM(CASE WHEN t.type IN ('disbursement','topup')
                      AND t.is_voided = 0 THEN t.amount END), 0)
  - COALESCE(SUM(CASE WHEN t.type = 'principal_payment'
                      AND t.is_voided = 0 THEN t.amount END), 0)  AS outstanding_principal,
    COALESCE(SUM(CASE WHEN t.type = 'interest_payment'
                      AND t.is_voided = 0 THEN t.amount END), 0)  AS interest_received
FROM loans l
LEFT JOIN transactions t ON t.loan_id = l.id
GROUP BY l.id;

-- ---------------------------------------------------------------------
-- NOTE: Interest OWED (accrued but unpaid) depends on how long each
-- amount of principal was outstanding, so it is calculated in the app
-- code (Step 4) from the transactions above, not stored in the schema.
-- ---------------------------------------------------------------------