// =====================================================================
//  VAULT — account recovery: look up your username, or reset a
//  forgotten password. Run this from the project folder (same place
//  as server.js) — it reuses your existing node_modules.
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

const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 12;
const DB_PATH = path.join(__dirname, 'data', 'vault.db');

function openDb() {
  try {
    return new Database(DB_PATH, { fileMustExist: true });
  } catch (err) {
    console.error(`\nCouldn't open the database at ${DB_PATH}`);
    console.error('Make sure you run this from the same folder as server.js, and that the app has been set up at least once.\n');
    process.exit(1);
  }
}

function listAccounts(db) {
  const users = db.prepare('SELECT username, full_name, role, is_active, last_login_at FROM users ORDER BY id').all();
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
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
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
  db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hash, user.id);
  console.log(`\nDone — the password for "${user.username}" has been reset. You can log in with it now.\n`);
}

async function main() {
  const db = openDb();
  const [, , cmd, arg] = process.argv;

  if (cmd === 'reset') {
    if (!arg) {
      console.error('\nUsage: node recover-account.js reset <username>\n');
      process.exit(1);
    }
    await resetPassword(db, arg);
  } else {
    listAccounts(db);
  }
  db.close();
}

main();