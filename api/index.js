// =====================================================================
//  VAULT — Vercel serverless entry point
// =====================================================================
//  Vercel treats every file under /api as its own serverless function.
//  This file is the ONLY thing that changes to go from "run with
//  node server.js" to "run on Vercel" — server.js itself is untouched.
//
//  How it works:
//   - server.js already guards `app.listen(...)` behind
//     `if (require.main === module)`, so requiring it here does NOT
//     start a second server — it just gives us the Express `app` and
//     the `ready` promise that resolves once migrations have run.
//   - On a cold start, Vercel spins up a fresh instance of this
//     function, which re-requires server.js, which re-runs
//     runMigrations(). That's safe (see server.js's own comments —
//     every migration is idempotent), and only happens once per cold
//     start, not once per request.
//   - `await ready` makes every request wait for that one-time setup
//     before Express ever sees it. On a warm instance `ready` is
//     already resolved, so this adds no real latency.
//
//  Put this file at:  api/index.js  (relative to the project root,
//  i.e. next to server.js, package.json, schema.sql).
// =====================================================================
'use strict';

const { app, ready } = require('../server.js');

module.exports = async (req, res) => {
  try {
    await ready;
  } catch (err) {
    // Migrations failed on this cold start (e.g. bad/missing Turso
    // env vars) — fail loudly instead of handing the request to an
    // Express app whose db never got wired up.
    console.error('[Vault] Startup failed, cannot handle request:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Server is not ready. Check deployment logs.' }));
    return;
  }
  return app(req, res);
};