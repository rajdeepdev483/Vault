// =====================================================================
//  VAULT  -  STEP 2: SERVER + LOGIN / LOGOUT
// =====================================================================
//  What this file does:
//   - Starts the web server
//   - Creates/opens the database (using schema.sql from Step 1)
//   - Secure login, logout and change-password
//   - Keeps users logged in for 30 days (sessions saved in the database,
//     so a server restart does NOT log anybody out)
//   - Makes an automatic backup of the whole database every 6 hours
//
//  Run it with:   node server.js
// =====================================================================
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { makeDb } = require('./lib/db');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// ---------------------------------------------------------------------
// SETTINGS (can be overridden with environment variables when deploying)
// ---------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
// On Vercel (and most serverless hosts) only /tmp is writable, and it does
// not persist between requests — it's just scratch space for building a
// backup file to stream down before the function exits.
const DATA_DIR = process.env.DATA_DIR || (IS_PROD ? os.tmpdir() : path.join(__dirname, 'data'));
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const SESSION_COOKIE = 'vault_sid';
const SESSION_DAYS = 30;
const BCRYPT_ROUNDS = 12;
// Optional secret code needed to create the very first account.
// Set this when the site is online so strangers cannot claim it.
const SETUP_CODE = process.env.SETUP_CODE || '';

// ---------------------------------------------------------------------
// DATABASE (Turso / libsql — set these in your Vercel project's
// Environment Variables, never commit them to the repo)
//   TURSO_DATABASE_URL  e.g. libsql://vault-xxxx.aws-ap-northeast-1.turso.io
//   TURSO_AUTH_TOKEN    the token from `turso db tokens create vault`
// ---------------------------------------------------------------------
if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('[Vault] Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN environment variables.');
  process.exit(1);
}
const db = makeDb({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
db.pragma('foreign_keys = ON'); // no-op placeholder, Turso enforces this already

// Create all tables from Step 1 (safe to run every time; existing data is untouched).
// Everything from here down that touches the database needs to happen after
// this finishes, so the rest of startup is wrapped in start().

// ---------------------------------------------------------------------
// MIGRATION: email-linked accounts + OTP codes
// Adds the new column/table to a database that was created before this
// feature existed. Safe to run every time the server starts. Nothing
// here ever deletes a user or their id — accounts are only ever
// soft-disabled (is_active = 0), never removed from the table, so a
// user's id and record are permanent.
// ---------------------------------------------------------------------
async function ensureColumn(table, column, ddl) {
  const cols = (await db.prepare(`PRAGMA table_info(${table})`).all()).map((c) => c.name);
  if (!cols.includes(column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// Runs the schema + every migration, in order, once, before the server
// starts accepting requests. Safe to run every time the process boots.
async function runMigrations() {
  await db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  // Legacy phone column (kept, untouched, for any pre-existing installs —
  // never dropped, since we never delete data). Email is now the
  // identity/verification channel used everywhere going forward.
  await ensureColumn('users', 'phone', 'phone TEXT');
  await ensureColumn('users', 'phone_verified_at', 'phone_verified_at TEXT');
  await ensureColumn('users', 'email', 'email TEXT');
  await ensureColumn('users', 'email_verified_at', 'email_verified_at TEXT');
  await ensureColumn('users', 'failed_attempts', 'failed_attempts INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'locked_until', 'locked_until TEXT');
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;`);
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;`);

  // MIGRATION: multi-account data isolation — every borrower (and
  // everything under it — loans, transactions) and every reminder now
  // belongs to the account that created it, so one signed-up user can
  // never see another user's records. Existing data (from before this
  // feature existed) is handed to the very first account, so nothing
  // already in the ledger becomes orphaned or newly visible to anyone else.
  await ensureColumn('borrowers', 'owner_id', 'owner_id INTEGER REFERENCES users(id)');
  await ensureColumn('reminders', 'owner_id', 'owner_id INTEGER REFERENCES users(id)');
  await db.exec(`UPDATE borrowers SET owner_id = (SELECT MIN(id) FROM users) WHERE owner_id IS NULL AND (SELECT MIN(id) FROM users) IS NOT NULL;`);
  await db.exec(`UPDATE reminders SET owner_id = (SELECT MIN(id) FROM users) WHERE owner_id IS NULL AND (SELECT MIN(id) FROM users) IS NOT NULL;`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_borrowers_owner ON borrowers(owner_id);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders(owner_id);`);

  // otp_codes holds only short-lived (10-minute) verification codes, never
  // account or ledger data, so recreating it fresh when upgrading from the
  // old phone-based shape (no "email" column yet) is safe and loses nothing
  // that matters — any in-flight code just needs to be requested again.
  {
    const otpCols = (await db.prepare("PRAGMA table_info(otp_codes)").all()).map((c) => c.name);
    if (otpCols.length && !otpCols.includes('email')) {
      await db.exec('DROP TABLE IF EXISTS otp_codes;');
    }
  }
  await db.exec(`
    CREATE TABLE IF NOT EXISTS otp_codes (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        email                    TEXT    NOT NULL,
        purpose                  TEXT    NOT NULL CHECK (purpose IN ('signup','reset','login')),
        code_hash                TEXT    NOT NULL,
        attempts                 INTEGER NOT NULL DEFAULT 0,
        verify_token_hash        TEXT,
        verify_token_expires_at  TEXT,
        consumed_at              TEXT,
        expires_at               TEXT    NOT NULL,
        created_at               TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_otp_email_purpose ON otp_codes(email, purpose);
  `);

  // Login sessions live in the database so restarts don't log people out
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash  TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at  TEXT NOT NULL,
        user_agent  TEXT,
        ip_address  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);
  await ensureColumn('sessions', 'ip_address', 'ip_address TEXT');

  // A setting that controls the "upcoming" list on the home page
  // (moved here from routes/dashboard.js so it runs after schema creation,
  // instead of racing it at route-registration time)
  await db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('upcoming_days', '7')");
}

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// A fake hash used so "user not found" takes as long as "wrong password"
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

function validUsername(u) {
  return typeof u === 'string' && /^[a-z0-9._-]{3,30}$/i.test(u.trim());
}
function validPassword(p) {
  // bcrypt only uses the first 72 bytes, so we cap the length there
  return typeof p === 'string' && p.length >= 8 && Buffer.byteLength(p) <= 72;
}

// ---------------------------------------------------------------------
// EMAIL + OTP HELPERS
// ---------------------------------------------------------------------
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 10;
const OTP_RESEND_COOLDOWN_SECONDS = 45;
const VERIFY_TOKEN_TTL_MINUTES = 15;

// Per-account lockout — separate from the per-IP authLimiter above. The IP
// limiter alone can't stop someone spraying guesses at one specific account
// from many different IPs/devices; this catches that by tracking failures
// on the account itself, no matter where they come from.
const MAX_FAILED_LOGIN_ATTEMPTS = 6;
const LOCKOUT_MINUTES = 15;

// Basic, forgiving email validation + normalization (trim + lowercase).
// Returns null if it doesn't look like a real email address.
function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Sends the OTP by email. Set EMAIL_PROVIDER to switch how it's sent:
//   (not set)   -> prints the code to this terminal window (free, for testing)
//   smtp        -> sends via any SMTP account, using nodemailer (free —
//                  works with a free Gmail account + an "app password",
//                  Outlook, Zoho Mail, Brevo's free SMTP, etc.). Needs
//                  EMAIL_SMTP_HOST, EMAIL_SMTP_PORT, EMAIL_SMTP_USER,
//                  EMAIL_SMTP_PASS, and optionally EMAIL_FROM.
//   resend      -> sends via Resend's HTTP API (free tier available).
//                  Needs RESEND_API_KEY and optionally EMAIL_FROM.
function otpEmailSubject(purpose) {
  if (purpose === 'signup') return 'Verify your email — Vault';
  if (purpose === 'reset') return 'Reset your password — Vault';
  if (purpose === 'login') return 'Your Vault login code';
  return 'Your Vault verification code';
}
async function sendOtpEmail(email, code, purpose) {
  const provider = (process.env.EMAIL_PROVIDER || (process.env.EMAIL_SMTP_HOST ? 'smtp' : 'console')).toLowerCase();
  const subject = otpEmailSubject(purpose);
  const text = `${code} is your Vault verification code. It is valid for ${OTP_TTL_MINUTES} minutes. Do not share this code with anyone.`;
  const html = `
    <div style="font-family:system-ui,sans-serif;font-size:15px;color:#0E1A3A;max-width:420px;margin:0 auto">
      <p>Your Vault verification code is:</p>
      <p style="font-size:30px;font-weight:800;letter-spacing:6px;margin:12px 0">${code}</p>
      <p style="color:#4B5878">It is valid for ${OTP_TTL_MINUTES} minutes. Do not share this code with anyone.</p>
    </div>`;

  if (provider === 'smtp') {
    // Requires the "nodemailer" package: npm install nodemailer
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_SMTP_HOST,
      port: Number(process.env.EMAIL_SMTP_PORT) || 587,
      secure: process.env.EMAIL_SMTP_SECURE === '1',
      auth: process.env.EMAIL_SMTP_USER
        ? { user: process.env.EMAIL_SMTP_USER, pass: process.env.EMAIL_SMTP_PASS }
        : undefined,
    });
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_SMTP_USER,
      to: email,
      subject,
      text,
      html,
    });
    return;
  }

  if (provider === 'resend') {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY is not set.');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'Vault <onboarding@resend.dev>',
        to: email,
        subject,
        text,
        html,
      }),
    });
    if (!r.ok) throw new Error(`Resend request failed (${r.status}).`);
    return;
  }

  // Default: no email provider configured yet, so print the code here
  // instead. This lets you test the whole flow for free before wiring up
  // real email sending.
  console.log(`\n[Vault] OTP for ${email}: ${code}   (no EMAIL_PROVIDER configured — see VAULT_BUILD_STEPS.md)\n`);
}

// Creates a fresh OTP for an email + purpose, enforcing the same
// per-address rate limits regardless of which flow (signup, reset, or
// login) is asking for it, then sends it. Throws HttpError on rate limit.
async function issueOtp(email, purpose) {
  const recentRow = await db
    .prepare(`SELECT COUNT(*) AS c FROM otp_codes WHERE email = ? AND purpose = ? AND created_at > datetime('now', '-1 hour')`)
    .get(email, purpose);
  if (recentRow.c >= OTP_MAX_PER_HOUR) {
    throw new HttpError(429, 'Too many codes requested for this email. Please wait a while and try again.');
  }
  const last = await db
    .prepare(`SELECT created_at FROM otp_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1`)
    .get(email, purpose);
  if (last) {
    const waited = (Date.now() - sqliteUtcToDate(last.created_at).getTime()) / 1000;
    if (waited < OTP_RESEND_COOLDOWN_SECONDS) {
      throw new HttpError(429, `Please wait ${Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - waited)} seconds before requesting another code.`);
    }
  }
  const code = generateOtp();
  await db.prepare(`INSERT INTO otp_codes (email, purpose, code_hash, expires_at) VALUES (?, ?, ?, datetime('now', ?))`).run(
    email, purpose, sha256(code), `+${OTP_TTL_MINUTES} minutes`
  );
  await sendOtpEmail(email, code, purpose);
}

// ---------------------------------------------------------------------
// OFF-SITE BACKUP (Step 8)
// After every local backup, also sends a copy off this computer, so a
// lost/stolen/damaged machine can't lose the data too. Off by default —
// set BACKUP_WEBHOOK_URL to turn it on. Works with any endpoint that
// accepts a POSTed file (a small relay, a cloud function, your own
// server, etc.); optionally add BACKUP_WEBHOOK_AUTH as a bearer/auth header.
// ---------------------------------------------------------------------
function offsiteBackupConfigured() {
  const url = process.env.BACKUP_WEBHOOK_URL;
  return { configured: !!url, provider: url ? 'webhook' : null };
}
async function sendBackupOffsite(filePath, fileName) {
  const url = process.env.BACKUP_WEBHOOK_URL;
  if (!url) return; // not configured — the local copy in data/backups is still kept
  try {
    const buffer = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([buffer]), fileName);
    form.append('app', 'vault');
    form.append('createdAt', new Date().toISOString());
    const r = await fetch(url, {
      method: 'POST',
      headers: process.env.BACKUP_WEBHOOK_AUTH ? { Authorization: process.env.BACKUP_WEBHOOK_AUTH } : {},
      body: form,
    });
    if (!r.ok) throw new Error(`Off-site backup upload failed (${r.status}).`);
  } catch (err) {
    console.error('Off-site backup failed (today\'s local backup is still safe):', err.message);
  }
}

// SQLite's datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS" with no
// timezone marker; this turns that back into a real Date for comparisons.
function sqliteUtcToDate(s) {
  return new Date(s.replace(' ', 'T') + 'Z');
}
function publicUser(u) {
  return { id: u.id, username: u.username, fullName: u.full_name, role: u.role };
}

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip_address)
     VALUES (?, ?, datetime('now', ?), ?, ?)`
  ).run(
    sha256(token),
    userId,
    `+${SESSION_DAYS} days`,
    String(req.get('user-agent') || '').slice(0, 200),
    String(req.ip || '').slice(0, 64)
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,                 // JavaScript on the page cannot read it
    sameSite: 'lax',                // blocks cross-site request forgery
    secure: IS_PROD,                // HTTPS only when live
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function setupCodeMatches(given) {
  if (!SETUP_CODE) return true;
  const a = Buffer.from(sha256(String(given || '')));
  const b = Buffer.from(sha256(SETUP_CODE));
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------
// SHARED TOOLS (used by the route files in the "routes" folder)
// ---------------------------------------------------------------------
const TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

// An error that carries a friendly message back to the browser
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Permanent history of every change (see audit_log in schema.sql)
async function audit(userId, table, recordId, action, oldData, newData) {
  await db.prepare(
    `INSERT INTO audit_log (user_id, table_name, record_id, action, old_data, new_data)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    userId || null,
    table,
    recordId,
    action,
    oldData ? JSON.stringify(oldData) : null,
    newData ? JSON.stringify(newData) : null
  );
}

// Money: the website talks in rupees, the database stores paise (whole numbers)
const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const toRupees = (paise) => (paise === null || paise === undefined ? null : paise / 100);

// Dates: always "YYYY-MM-DD"
function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(dateStr, n) {
  const [y, m, day] = dateStr.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();   // e.g. 31 Jan + 1 month = 28/29 Feb
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------
// APP + SECURITY MIDDLEWARE
// ---------------------------------------------------------------------
const app = express();
if (IS_PROD) app.set('trust proxy', 1);   // needed behind hosting proxies (HTTPS)

// Optional: redirect plain HTTP to HTTPS. Off by default because most
// hosts (Render, Railway, Fly, etc.) already terminate HTTPS for you and
// this would be redundant; turn it on with FORCE_HTTPS=1 only if your
// host does NOT already do this for you.
if (IS_PROD && process.env.FORCE_HTTPS === '1') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] === 'http') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: IS_PROD ? [] : null,
      },
    },
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Never let the browser cache API answers (data must always be fresh)
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Who is logged in? (runs on every request)
app.use(async (req, res, next) => {
  req.user = null;
  req.sessionHash = null;
  try {
    const token = req.cookies && req.cookies[SESSION_COOKIE];
    if (token) {
      const hash = sha256(token);
      const row = await db
        .prepare(
          `SELECT u.id, u.username, u.full_name, u.role
             FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.is_active = 1`
        )
        .get(hash);
      if (row) {
        req.user = row;
        req.sessionHash = hash;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Use this on any route that needs a logged-in user
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  next();
}

// Slows down password guessing: 20 failed tries per 15 minutes per device/IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

// Slows down OTP requests/verifies per device/IP (money is spent per SMS,
// so this matters even more than the password limiter above)
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});

// ---------------------------------------------------------------------
// API: HEALTH + AUTH
// ---------------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, app: 'Vault' }));

// The front end calls this first to decide: show setup, login, or the app
app.get('/api/auth/status', async (req, res) => {
  const setupRequired = (await db.prepare('SELECT COUNT(*) AS c FROM users').get()).c === 0;
  res.json({
    setupRequired,
    setupCodeRequired: setupRequired && !!SETUP_CODE,
    user: req.user ? publicUser(req.user) : null,
  });
});

// ---------------------------------------------------------------------
// EMAIL VERIFICATION (OTP) — used by first-time setup and forgot-password.
// (The third purpose, "login", is never requested through this public
// endpoint — it's only ever issued server-side, after a correct password,
// from inside /api/auth/login below, so a stranger can't use it to spam
// someone's inbox without already knowing their password.)
// Two steps: request a code, then verify it. A successful verify returns
// a short-lived token that must be presented to /api/auth/setup or
// /api/auth/forgot-password/reset to finish.
// ---------------------------------------------------------------------
app.post('/api/auth/otp/request', otpLimiter, async (req, res) => {
  const body = req.body || {};
  const purpose = body.purpose;
  if (!['signup', 'reset'].includes(purpose)) {
    return res.status(400).json({ error: 'Invalid request.' });
  }
  const email = normalizeEmail(body.email);
  if (!email) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  // Anyone can sign up, any time — but one email address can only ever
  // back one account, so an already-registered address can't sign up again.
  if (purpose === 'signup' && await db.prepare('SELECT 1 FROM users WHERE email = ? AND is_active = 1').get(email)) {
    return res.status(403).json({ error: 'An account with this email address already exists. Try logging in instead.' });
  }

  // For a password reset, only actually send a code if that address is
  // registered — but always answer the same way either way, so the form
  // can't be used to check which addresses have accounts.
  if (purpose === 'reset' && !(await db.prepare('SELECT 1 FROM users WHERE email = ? AND is_active = 1').get(email))) {
    return res.json({ ok: true, expiresInSeconds: OTP_TTL_MINUTES * 60 });
  }

  try {
    await issueOtp(email, purpose);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error('Failed to send OTP email:', err.message);
    return res.status(502).json({ error: 'Could not send the code right now. Please try again shortly.' });
  }

  res.json({ ok: true, expiresInSeconds: OTP_TTL_MINUTES * 60 });
});

app.post('/api/auth/otp/verify', otpLimiter, async (req, res) => {
  const body = req.body || {};
  const purpose = body.purpose;
  if (!['signup', 'reset', 'login'].includes(purpose)) {
    return res.status(400).json({ error: 'Invalid request.' });
  }
  const email = normalizeEmail(body.email);
  if (!email) return res.status(400).json({ error: 'Enter a valid email address.' });
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });

  const row = await db
    .prepare(
      `SELECT * FROM otp_codes WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > datetime('now')
       ORDER BY id DESC LIMIT 1`
    )
    .get(email, purpose);
  if (!row) return res.status(400).json({ error: 'That code has expired or was not found. Please request a new one.' });
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many incorrect attempts. Please request a new code.' });
  }
  if (sha256(code) !== row.code_hash) {
    await db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return res.status(400).json({ error: 'Incorrect code. Please try again.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare(`UPDATE otp_codes SET verify_token_hash = ?, verify_token_expires_at = datetime('now', ?) WHERE id = ?`).run(
    sha256(token), `+${VERIFY_TOKEN_TTL_MINUTES} minutes`, row.id
  );

  res.json({ verified: true, verificationToken: token, expiresInSeconds: VERIFY_TOKEN_TTL_MINUTES * 60 });
});

// Account creation — anyone can sign up. The email address must have just
// been verified with a code via /api/auth/otp/verify above. Only the very
// first account on a fresh site is gated by an optional setup code; every
// account after that is a normal public sign-up. Each account's borrowers,
// loans and reminders are private to it (see the owner_id migration above).
app.post('/api/auth/setup', authLimiter, async (req, res) => {
  const { fullName, username, password, setupCode, verificationToken } = req.body || {};

  const isFirstAccount = (await db.prepare('SELECT COUNT(*) AS c FROM users').get()).c === 0;
  if (isFirstAccount && !setupCodeMatches(setupCode)) {
    return res.status(403).json({ error: 'Incorrect setup code.' });
  }
  const email = normalizeEmail((req.body || {}).email);
  if (!email) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 80) {
    return res.status(400).json({ error: 'Please enter a full name (up to 80 characters).' });
  }
  if (!validUsername(username)) {
    return res.status(400).json({
      error: 'Username must be 3-30 characters: letters, numbers, dot, dash or underscore.',
    });
  }
  if (!validPassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters (max 72).' });
  }

  const otpRow = await db
    .prepare(
      `SELECT * FROM otp_codes WHERE email = ? AND purpose = 'signup' AND consumed_at IS NULL
         AND verify_token_hash = ? AND verify_token_expires_at > datetime('now')
       ORDER BY id DESC LIMIT 1`
    )
    .get(email, sha256(String(verificationToken || '')));
  if (!otpRow) {
    return res.status(403).json({ error: 'Please verify your email again — the verification has expired.' });
  }

  // Every account created here keeps its row (and its id) forever — the
  // app only ever soft-disables an account (is_active = 0), it never runs
  // DELETE on the users table.
  const userId = await db.transaction(async () => {
    const info = await db
      .prepare('INSERT INTO users (username, password_hash, full_name, role, email, email_verified_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))')
      .run(username.trim().toLowerCase(), bcrypt.hashSync(password, BCRYPT_ROUNDS), fullName.trim(), 'admin', email);
    await db.prepare("UPDATE otp_codes SET consumed_at = datetime('now') WHERE id = ?").run(otpRow.id);
    return info.lastInsertRowid;
  })();

  await startSession(req, res, userId);
  await db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.status(201).json({ user: publicUser(user) });
});

// Step 1 of login: username + password. On success this does NOT start a
// session yet — it emails a one-time code to the account's address and
// asks the browser to call /api/auth/login/complete with it. This runs
// every time someone logs in (including right after a logout), so a
// stolen password alone is never enough to get in.
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Please enter your username and password.' });
  }

  const user = await db
    .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
    .get(username.trim().toLowerCase());

  if (user && user.locked_until && sqliteUtcToDate(user.locked_until).getTime() > Date.now()) {
    const mins = Math.ceil((sqliteUtcToDate(user.locked_until).getTime() - Date.now()) / 60000);
    return res.status(423).json({ error: `Too many failed attempts. Please try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
  }

  const passwordOk = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    if (user) {
      const attempts = (user.failed_attempts || 0) + 1;
      if (attempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        await db.prepare(`UPDATE users SET failed_attempts = 0, locked_until = datetime('now', ?) WHERE id = ?`)
          .run(`+${LOCKOUT_MINUTES} minutes`, user.id);
      } else {
        await db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(attempts, user.id);
      }
    }
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  await db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);

  if (!user.email) {
    // Account predates email-based accounts (e.g. an old phone-only
    // account). Nothing about it is deleted, but it needs an email on
    // file before it can complete the new OTP step.
    return res.status(409).json({
      error: 'Your account needs an email address on file before you can log in. Please contact support to add one.',
    });
  }

  try {
    await issueOtp(user.email, 'login');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error('Failed to send login OTP email:', err.message);
    return res.status(502).json({ error: 'Could not send the login code right now. Please try again shortly.' });
  }

  // The browser needs the real address back to complete the next two
  // calls (otp/verify and login/complete) — the user already proved they
  // know the account's password, so this isn't exposing anything they
  // don't already have a right to see. The front end masks it for display.
  res.json({ otpRequired: true, email: user.email, expiresInSeconds: OTP_TTL_MINUTES * 60 });
});

// Step 2 of login: the 6-digit code from step 1, already verified via
// POST /api/auth/otp/verify (purpose "login") into a verificationToken.
// This is what actually starts the session.
app.post('/api/auth/login/complete', authLimiter, async (req, res) => {
  const body = req.body || {};
  const email = normalizeEmail(body.email);
  if (!email) return res.status(400).json({ error: 'Enter a valid email address.' });

  const otpRow = await db
    .prepare(
      `SELECT * FROM otp_codes WHERE email = ? AND purpose = 'login' AND consumed_at IS NULL
         AND verify_token_hash = ? AND verify_token_expires_at > datetime('now')
       ORDER BY id DESC LIMIT 1`
    )
    .get(email, sha256(String(body.verificationToken || '')));
  if (!otpRow) {
    return res.status(403).json({ error: 'Please verify the code again — it has expired.' });
  }
  const user = await db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email);
  if (!user) return res.status(404).json({ error: 'No account found.' });

  await db.prepare("UPDATE otp_codes SET consumed_at = datetime('now') WHERE id = ?").run(otpRow.id);
  await startSession(req, res, user.id);
  await db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', async (req, res) => {
  if (req.sessionHash) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Update your own profile — full name and/or username. Changing the
// username needs your current password (same as changing your password),
// since the username is also your login ID.
app.patch('/api/auth/me', requireAuth, authLimiter, async (req, res) => {
  const body = req.body || {};
  const wantsFullName = typeof body.fullName === 'string';
  const wantsUsername = typeof body.username === 'string';
  if (!wantsFullName && !wantsUsername) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const updates = {};

  if (wantsFullName) {
    const fullName = body.fullName.trim();
    if (!fullName || fullName.length > 80) {
      return res.status(400).json({ error: 'Full name must be 1-80 characters.' });
    }
    updates.full_name = fullName;
  }

  if (wantsUsername) {
    const username = body.username.trim().toLowerCase();
    if (!validUsername(username)) {
      return res.status(400).json({ error: 'Username must be 3-30 characters (letters, numbers, dots, dashes, underscores).' });
    }
    if (typeof body.currentPassword !== 'string' || !bcrypt.compareSync(body.currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Enter your current password to change your username.' });
    }
    if (username !== user.username) {
      const clash = await db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(username, user.id);
      if (clash) return res.status(409).json({ error: 'That username is already taken.' });
    }
    updates.username = username;
  }

  const sets = Object.keys(updates);
  await db.prepare(
    `UPDATE users SET ${sets.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).run(...sets.map((c) => updates[c]), user.id);

  const fresh = await db.prepare('SELECT id, username, full_name, role FROM users WHERE id = ?').get(user.id);
  res.json({ user: publicUser(fresh) });
});

app.post('/api/auth/change-password', requireAuth, authLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !validPassword(newPassword)) {
    return res.status(400).json({ error: 'New password must be at least 8 characters (max 72).' });
  }
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    bcrypt.hashSync(newPassword, BCRYPT_ROUNDS),
    user.id
  );
  // Log out every other device; keep this one
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, req.sessionHash);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// SIGNED-IN DEVICES — lets you see every device currently logged into
// your account and kick out any you don't recognize, without needing
// your password again. token_hash is a one-way hash of the actual
// session cookie, so exposing it as an id here can't be turned back
// into a usable login token.
// ---------------------------------------------------------------------
app.get('/api/auth/sessions', requireAuth, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT token_hash, created_at, expires_at, user_agent, ip_address
         FROM sessions WHERE user_id = ? ORDER BY created_at DESC`
    )
    .all(req.user.id);
  res.json({
    sessions: rows.map((r) => ({
      id: r.token_hash,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      userAgent: r.user_agent,
      ipAddress: r.ip_address,
      isCurrent: r.token_hash === req.sessionHash,
    })),
  });
});

app.delete('/api/auth/sessions/:id', requireAuth, async (req, res) => {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (req.params.id === req.sessionHash) res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.delete('/api/auth/sessions', requireAuth, async (req, res) => {
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, req.sessionHash);
  res.json({ ok: true });
});

// Forgotten password: email must have just been verified with a code via
// /api/auth/otp/verify (purpose "reset") above.
app.post('/api/auth/forgot-password/reset', authLimiter, async (req, res) => {
  const body = req.body || {};
  const email = normalizeEmail(body.email);
  if (!email) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!validPassword(body.newPassword)) {
    return res.status(400).json({ error: 'New password must be at least 8 characters (max 72).' });
  }

  const otpRow = await db
    .prepare(
      `SELECT * FROM otp_codes WHERE email = ? AND purpose = 'reset' AND consumed_at IS NULL
         AND verify_token_hash = ? AND verify_token_expires_at > datetime('now')
       ORDER BY id DESC LIMIT 1`
    )
    .get(email, sha256(String(body.verificationToken || '')));
  if (!otpRow) {
    return res.status(403).json({ error: 'Please verify your email again — the verification has expired.' });
  }

  const user = await db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email);
  if (!user) return res.status(404).json({ error: 'No account found with that email address.' });

  await db.transaction(async () => {
    await db.prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?').run(bcrypt.hashSync(body.newPassword, BCRYPT_ROUNDS), user.id);
    await db.prepare("UPDATE otp_codes SET consumed_at = datetime('now') WHERE id = ?").run(otpRow.id);
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);   // sign the account out everywhere, for safety
  })();

  res.json({ ok: true, username: user.username });
});

// ---------------------------------------------------------------------
// API ROUTES
// ---------------------------------------------------------------------
// NOTE: this used to be `fs.readdirSync('routes').forEach(f =>
// require(...))` — convenient locally, but Vercel's build step uses
// static analysis (file tracing) to decide which files to bundle into
// the serverless function, and a require() built from a runtime string
// is invisible to that analysis. Locally every file in routes/ exists
// on disk so `node server.js` works fine either way; on Vercel the
// routes/*.js files silently never made it into the deployed bundle,
// so the very first request hit "Cannot find module './routes/...'"
// and crashed the function — that's the 500 FUNCTION_INVOCATION_FAILED
// you saw. Explicit requires below fix that, at the cost of one extra
// line here whenever a new routes/*.js file is added.
[
  require('./routes/backup.js'),
  require('./routes/borrowers-loans.js'),
  require('./routes/dashboard.js'),
  require('./routes/payments.js'),
].forEach((registerRoutes) => registerRoutes({
  app, db, requireAuth, audit, HttpError,
  toPaise, toRupees, isDate, todayStr, addDays, addMonths,
  DATA_DIR, BACKUP_DIR, offsiteBackupConfigured,
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------------------------------------------------------------------
// FRONT END FILES (the website itself goes in the "public" folder later)
// ---------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// Temporary test page, shown only until public/index.html exists
app.get('/', (req, res) => {
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"
  );
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vault - server test</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:520px;margin:24px auto;padding:0 16px;background:#0f1216;color:#e8e6df}
  h1{font-size:22px} input{display:block;width:100%;padding:10px;margin:6px 0;border-radius:8px;border:1px solid #333;background:#181c22;color:inherit;box-sizing:border-box}
  button{padding:10px 14px;margin:6px 6px 0 0;border:0;border-radius:8px;background:#c9a24a;color:#111;font-weight:600;cursor:pointer}
  pre{background:#181c22;padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<h1>Vault server is running</h1>
<p>This is a temporary test page for the login system. The real website comes in later steps.</p>
<input id="fullName" placeholder="Full name (setup only)">
<input id="username" placeholder="Username">
<input id="password" type="password" placeholder="Password (min 8 characters)">
<input id="setupCode" placeholder="Setup code (only if you set one)">
<button id="setup">Create first account</button>
<button id="login">Log in</button>
<button id="me">Who am I?</button>
<button id="logout">Log out</button>
<pre id="out">...</pre>
<script>
  var out = document.getElementById('out');
  function val(id){ return document.getElementById(id).value; }
  async function call(method, url, body){
    var res = await fetch(url, { method: method, headers: {'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined });
    var data = {}; try { data = await res.json(); } catch(e) {}
    out.textContent = method + ' ' + url + '  ->  ' + res.status + '\\n' + JSON.stringify(data, null, 2);
  }
  document.getElementById('setup').onclick  = function(){ call('POST','/api/auth/setup',{fullName:val('fullName'),username:val('username'),password:val('password'),setupCode:val('setupCode')}); };
  document.getElementById('login').onclick  = function(){ call('POST','/api/auth/login',{username:val('username'),password:val('password')}); };
  document.getElementById('me').onclick     = function(){ call('GET','/api/auth/me'); };
  document.getElementById('logout').onclick = function(){ call('POST','/api/auth/logout',{}); };
  call('GET','/api/auth/status');
</script></body></html>`);
});

// ---------------------------------------------------------------------
// ERROR HANDLING
// ---------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...err.extra });
  }
  if (err && err.status && err.status < 500) {
    return res.status(err.status).json({ error: 'Invalid request.' });
  }
  console.error('Server error:', err);
  res.status(500).json({ error: 'Something went wrong on the server. Your data is safe.' });
});

// ---------------------------------------------------------------------
// AUTOMATIC BACKUPS (every 6 hours, keeps the last 30 days of dumps)
// NOTE: on Vercel/serverless hosting this setInterval will NOT reliably
// fire — a serverless function doesn't stay running between requests.
// Treat this as a convenience for a traditional always-on host (Render,
// Railway, a VPS, etc.); on Vercel, rely on Turso's own backups/branching
// for point-in-time recovery instead, and use the on-demand
// /api/backup/download route (which works anywhere) for manual snapshots.
// ---------------------------------------------------------------------
async function runBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const fileName = `vault-${day}.sql`;
    const filePath = path.join(BACKUP_DIR, fileName);
    await db.dumpToFile(filePath, fs);
    await sendBackupOffsite(filePath, fileName);

    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => /^vault-\d{4}-\d{2}-\d{2}\.sql$/.test(f))
      .sort();
    while (files.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (err) {
    console.error('Backup failed:', err.message);
  }
}

// ---------------------------------------------------------------------
// PRODUCTION CHECKLIST — friendly reminders printed once at startup so
// nothing important is missed when this goes live for real (Step 8).
// ---------------------------------------------------------------------
if (IS_PROD) {
  if (!SETUP_CODE) {
    console.warn('[Vault] WARNING: SETUP_CODE is not set. Set it before going live so a stranger cannot create the first account before you do.');
  }
  if (!process.env.BACKUP_WEBHOOK_URL) {
    console.warn('[Vault] NOTE: No off-site backup is configured (BACKUP_WEBHOOK_URL). On Vercel, prefer Turso\'s own backups — see DEPLOYMENT.md.');
  }
}

// Remove expired login sessions once an hour
async function cleanSessions() {
  try {
    await db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  } catch (err) {
    console.error('cleanSessions failed:', err.message);
  }
}

// ---------------------------------------------------------------------
// START + SAFE SHUTDOWN
// Migrations must finish before anything touches the database, so
// everything below waits on runMigrations().
// ---------------------------------------------------------------------
let server = null;
const ready = runMigrations()
  .then(() => {
    // Only auto-listen when this file is run directly (`node server.js`)
    // — a traditional host. On Vercel, this file is imported by a
    // serverless entry point instead, so it should just export `app`.
    if (require.main === module) {
      runBackup();
      setInterval(runBackup, 6 * 60 * 60 * 1000).unref();
      cleanSessions();
      setInterval(cleanSessions, 60 * 60 * 1000).unref();
      server = app.listen(PORT, () => {
        console.log(`Vault is running:  http://localhost:${PORT}`);
      });
    }
  })
  .catch((err) => {
    console.error('[Vault] Failed to start (migrations):', err);
    // Only kill the whole process for a traditional `node server.js`
    // host, where there's no other way to signal a fatal boot failure.
    // On Vercel (require.main !== module here — this file was required
    // by api/index.js) process.exit(1) would take the entire serverless
    // instance down before it ever gets to respond, so instead let this
    // rejection propagate: `ready` rejects, and api/index.js's own
    // catch already turns that into a clean 500 response.
    if (require.main === module) {
      process.exit(1);
    }
    throw err;
  });

// `ready` may stay rejected for a moment before anything actually reads
// it — api/index.js only does `await ready` once the first HTTP request
// comes in, which can be a tick or more after this module first loads
// at cold start. Node treats a promise rejection with zero attached
// handlers, once the microtask queue drains, as fatal and kills the
// whole process — exactly the crash this was meant to avoid. Attaching
// a silent handler here marks `ready` as "handled" for that check,
// without affecting the real rejection that api/index.js awaits below
// (a promise can have more than one .then()/.catch() attached to it).
ready.catch(() => {});

function shutdown() {
  console.log('Shutting down safely...');
  if (server) {
    server.close(() => {
      try { db.close(); } catch (e) { /* ignore */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  } else {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Export the Express `app` itself as the default export — it's callable
// (Express apps are just `function(req, res)` under the hood), so this
// is valid whether Vercel invokes it via api/index.js's own
// `require('../server.js')` destructuring below, OR ends up treating
// this file as a serverless function/entry point in its own right
// (which needs a function or server as the default export, not a plain
// object). `ready` rides along as a property on the same export so
// api/index.js can still get both.
app.ready = ready;
module.exports = app;