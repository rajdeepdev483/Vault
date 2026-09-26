// =====================================================================
//  VAULT — account recovery: look up your username, or reset a
//  forgotten password. Run this from the project folder (same place
//  as server.js) — it reuses your existing node_modules.
//
//  Needs the same TURSO_DATABASE_URL / TURSO_AUTH_TOKEN environment
//  variables as server.js, since accounts now live in Turso, not in a
//  local data/vault.db file. Easiest way to set them for one run:
//    TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node recover-account.js
//  (or `source` a .env file first, however you normally load one)
//
//  See who your accounts are:
//    node recover-account.js
//
//  Reset a password (you'll be asked to type the new one twice):
//    node recover-account.js reset <username>
//
//  This only ever touches the one password_hash field for the account
//  you name. Borrowers, loans, and transactions are never touched.
// =====================================================================
'use strict';

const readline = require('readline');
const bcrypt = require('bcryptjs');
const { makeDb } = require('./lib/db');

const BCRYPT_ROUNDS = 12;

function openDb() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    console.error('\nMissing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN environment variables.');
    console.error('Set the same two variables you use for server.js, then run this again.\n');
    process.exit(1);
  }
  return makeDb({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

async function listAccounts(db) {
  const users = await db.prepare('SELECT username, full_name, role, is_active, last_login_at FROM users ORDER BY id').all();
  if (users.length === 0) {
    console.log('\nNo accounts found yet — the app has not been set up.\n');
    return;
  }
  console.log('\nAccounts on this Vault:\n');
  for (const u of users) {
    console.log(`  Username: ${u.username}`);
    console.log(`  Name:     ${u.full_name}`);
    console.log(`  Role:     ${u.role}${u.is_active ? '' : '  (disabled)'}`);
    console.log(`  Last login: ${u.last_login_at || 'never'}`);
    console.log('');
  }
  console.log('To reset a password, run:');
  console.log(`  node recover-account.js reset <username>\n`);
}

function askTwoLines(rl, prompt1, prompt2) {
  return new Promise((resolve) => {
    let first = null;
    rl.setPrompt(prompt1);
    rl.prompt();
    rl.on('line', (line) => {
      if (first === null) {
        first = line;
        rl.setPrompt(prompt2);
        rl.prompt();
      } else {
        rl.close();
        resolve([first, line]);
      }
    });
  });
}

async function resetPassword(db, username) {
  const uname = String(username || '').trim().toLowerCase();
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
  if (!user) {
    console.error(`\nNo account found with username "${uname}". Run "node recover-account.js" with no arguments to see the list.\n`);
    process.exit(1);
  }

  console.log(`\nResetting the password for "${user.username}" (${user.full_name}).`);
  console.log('(What you type will be visible on screen — this is a local recovery tool.)\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const [pw1, pw2] = await askTwoLines(rl, 'New password (at least 8 characters): ', 'Type it again to confirm: ');

  if (!pw1 || pw1.length < 8) {
    console.error('\nPassword must be at least 8 characters. Nothing was changed.\n');
    process.exit(1);
  }
  if (pw1 !== pw2) {
    console.error('\nThe two entries did not match. Nothing was changed.\n');
    process.exit(1);
  }

  const hash = bcrypt.hashSync(pw1, BCRYPT_ROUNDS);
  await db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hash, user.id);
  console.log(`\nDone — the password for "${user.username}" has been reset. You can log in with it now.\n`);
}

async function main() {
  const db = openDb();
  const [, , cmd, arg] = process.argv;

  try {
    if (cmd === 'reset') {
      if (!arg) {
        console.error('\nUsage: node recover-account.js reset <username>\n');
        process.exit(1);
      }
      await resetPassword(db, arg);
    } else {
      await listAccounts(db);
    }
  } finally {
    db.close();
  }
}

main();