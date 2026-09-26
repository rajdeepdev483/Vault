// =====================================================================
//  VAULT  -  lib/db.js
// =====================================================================
//  Thin wrapper around @libsql/client that makes a remote Turso database
//  look like the better-sqlite3 object the rest of the app was written
//  against, so server.js and routes/*.js didn't need to change their
//  db.prepare(...).get()/.all()/.run() call sites.
//
//  Differences from better-sqlite3 that this file has to paper over:
//   - Turso is over the network, so every call is async now. Every
//     method here returns a Promise; every call site must use await.
//   - There's one shared connection, not an in-process file lock, so a
//     multi-step transaction has to be told which statements belong to
//     it. Since db.transaction(fn) is called as
//         await db.transaction(async () => { ...db.prepare(...)... })()
//     (the callback doesn't receive a transaction handle — it just
//     calls back into the same `db`), we track "is there a transaction
//     running right now, for this particular request" with
//     AsyncLocalStorage, and prepare()/exec() check it before deciding
//     whether to run against the shared client or the open transaction.
//   - There's no local file to run better-sqlite3's `.backup()` on, so
//     dumpToFile() below builds a plain .sql dump (schema + INSERT
//     statements) by querying sqlite_master and every table, and streams
//     it straight to disk.
//
//  Usage (see server.js):
//    const { makeDb } = require('./lib/db');
//    const db = makeDb({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
//    db.pragma('foreign_keys = ON');           // no-op; Turso enforces this already
//    await db.exec('CREATE TABLE ...; ...');   // multi-statement, no params
//    await db.prepare('SELECT * FROM x WHERE id = ?').get(id);
//    await db.prepare('SELECT * FROM x WHERE id = @id').get({ id });
//    await db.prepare('INSERT INTO x (a,b) VALUES (?,?)').run(a, b);
//    const result = await db.transaction(async () => { ... })();
//    await db.dumpToFile('/path/to/backup.sql', require('fs'));
//    db.close();
// =====================================================================
'use strict';

const { createClient } = require('@libsql/client');
const { AsyncLocalStorage } = require('async_hooks');

// Holds { tx } for whichever request is currently inside
// db.transaction(...)(), scoped per async call chain — so two requests
// running transactions at the same time never see each other's tx.
const txContext = new AsyncLocalStorage();

// ---------------------------------------------------------------------
// Turns whatever was passed to .get()/.all()/.run() into the shape
// @libsql/client wants for `args`. Mirrors better-sqlite3's own
// flexibility: positional ?-placeholders take a plain list (spread or a
// single array), named @/:/$-placeholders take a single plain object.
// ---------------------------------------------------------------------
function normalizeArgs(callArgs) {
  if (callArgs.length === 0) return [];
  if (callArgs.length === 1 && Array.isArray(callArgs[0])) {
    return callArgs[0].map(normalizeValue);
  }
  if (
    callArgs.length === 1 &&
    callArgs[0] !== null &&
    typeof callArgs[0] === 'object' &&
    !(callArgs[0] instanceof Uint8Array)
  ) {
    const out = {};
    for (const [key, value] of Object.entries(callArgs[0])) {
      out[key.replace(/^[@:$]/, '')] = normalizeValue(value);
    }
    return out;
  }
  return callArgs.map(normalizeValue);
}

function normalizeValue(v) {
  // libsql's arg types don't include `undefined` (only null); everything
  // else (string/number/bigint/boolean/Uint8Array/null) passes straight through.
  return v === undefined ? null : v;
}

// A libsql ResultSet's rows are array-like, not plain objects — turn one
// into a plain { column: value } object using the ResultSet's own columns.
function rowToObject(row, columns) {
  const obj = {};
  for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
  return obj;
}

// ---------------------------------------------------------------------
// Renders one JS value as a SQL literal, for the plain-text .sql dump
// produced by dumpToFile(). Not used for real queries (those always go
// through parameterized args above) — only for building the backup file.
// ---------------------------------------------------------------------
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof ArrayBuffer || v instanceof Uint8Array) {
    return `X'${Buffer.from(v).toString('hex')}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

function makeDb({ url, authToken, ...rest }) {
  if (!url) throw new Error('makeDb: a Turso "url" is required.');
  const client = createClient({ url, authToken, ...rest });

  // Whatever statement runs next should go through the open transaction
  // for this request, if there is one — otherwise straight to the client.
  function currentExecutor() {
    const store = txContext.getStore();
    return store ? store.tx : client;
  }

  async function execute(sql, args) {
    return currentExecutor().execute({ sql, args });
  }

  function prepare(sql) {
    return {
      async get(...callArgs) {
        const rs = await execute(sql, normalizeArgs(callArgs));
        return rs.rows.length ? rowToObject(rs.rows[0], rs.columns) : undefined;
      },
      async all(...callArgs) {
        const rs = await execute(sql, normalizeArgs(callArgs));
        return rs.rows.map((row) => rowToObject(row, rs.columns));
      },
      async run(...callArgs) {
        const rs = await execute(sql, normalizeArgs(callArgs));
        return {
          lastInsertRowid: rs.lastInsertRowid === undefined || rs.lastInsertRowid === null
            ? undefined
            : Number(rs.lastInsertRowid),
          changes: rs.rowsAffected,
        };
      },
    };
  }

  // Multi-statement, no-params SQL (schema.sql, ALTER TABLE migrations).
  // Always runs directly against the client — nothing in this app calls
  // db.exec() from inside a db.transaction(), so this doesn't need to be
  // transaction-aware (a Transaction object has no executeMultiple()).
  async function exec(sql) {
    await client.executeMultiple(sql);
  }

  // db.transaction(fn) — call the returned function to actually run it,
  // e.g. `await db.transaction(async () => { ... })()`. Everything the
  // callback does through db.prepare(...) while it runs is bound, via
  // AsyncLocalStorage, to one open libsql transaction; it commits if the
  // callback resolves and rolls back if it throws.
  function transaction(fn) {
    return async (...args) => {
      // Nested calls (a transaction started while already inside one)
      // just reuse the outer transaction — libsql can't nest them.
      if (txContext.getStore()) return fn(...args);

      const tx = await client.transaction('write');
      try {
        const result = await txContext.run({ tx }, () => fn(...args));
        await tx.commit();
        return result;
      } catch (err) {
        try {
          await tx.rollback();
        } catch (_) {
          // tx may already be closed by a failed commit — ignore.
        }
        throw err;
      }
    };
  }

  // No-op: kept so `db.pragma('foreign_keys = ON')` in server.js doesn't
  // need an `if` around it. Turso/libsql enforces foreign keys already.
  function pragma() {}

  // Writes a plain-text .sql dump (schema + INSERT statements for every
  // row, in dependency-safe creation order) into any writable stream —
  // an fs write stream, an HTTP response, whatever the caller hands in.
  // Doesn't end/close the stream itself; the caller owns that (a file
  // needs `.end()`, an HTTP response needs headers set first and often
  // wants to end itself after an error).
  async function dumpToStream(writable) {
    const writeErr = new Promise((_, reject) => writable.once('error', reject));
    const write = (chunk) =>
      Promise.race([
        new Promise((resolve) => {
          if (writable.write(chunk)) resolve();
          else writable.once('drain', resolve);
        }),
        writeErr,
      ]);

    await write('PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n');

    const schemaRs = await client.execute(
      "SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid"
    );
    const objects = schemaRs.rows.map((r) => rowToObject(r, schemaRs.columns));

    // Structure first (tables, indexes, triggers) so every CREATE
    // statement exists before any data below tries to insert into it.
    for (const obj of objects) {
      await write(`${obj.sql};\n`);
    }

    // Then data, table by table, one INSERT per row.
    for (const table of objects.filter((o) => o.type === 'table')) {
      const dataRs = await client.execute(`SELECT * FROM "${table.name}"`);
      const colList = dataRs.columns.map((c) => `"${c}"`).join(', ');
      for (const row of dataRs.rows) {
        const values = dataRs.columns.map((_, i) => sqlLiteral(row[i])).join(', ');
        await write(`INSERT INTO "${table.name}" (${colList}) VALUES (${values});\n`);
      }
    }

    await write('COMMIT;\n');
  }

  // Writes the same dump straight to filePath, via the caller's own
  // `fs` module. Used by the scheduled backup (server.js) which always
  // needs an actual file on disk to prune old copies of.
  async function dumpToFile(filePath, fsModule) {
    const fsMod = fsModule || require('fs');
    const out = fsMod.createWriteStream(filePath, { encoding: 'utf8' });
    try {
      await dumpToStream(out);
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
  }

  function close() {
    client.close();
  }

  return { prepare, exec, transaction, pragma, dumpToFile, dumpToStream, close };
}

module.exports = { makeDb };