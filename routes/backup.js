// =====================================================================
//  VAULT  -  STEP 8: BACKUPS
// =====================================================================
//  GET  /api/backup/download   one-tap: makes a fresh backup right now
//                               and sends it straight to the browser
//  GET  /api/backup/status     when the last automatic backup ran, how
//                               many are kept, and whether an off-site
//                               copy is configured (never reveals the URL)
//
//  The automatic backup itself (every 6 hours, last 30 days kept, and
//  the optional off-site copy) lives in server.js.
// =====================================================================
'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function (ctx) {
  const { app, db, requireAuth, BACKUP_DIR, offsiteBackupConfigured } = ctx;

  app.get('/api/backup/download', requireAuth, async (req, res) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      // Stream rows straight from Turso to the browser as they're
      // fetched — no temp file, no extra read-back-and-resend pass.
      // On a host with metered function time (Vercel) this roughly
      // halves how long a large dump takes to finish sending, and it
      // means /tmp filling up is never a factor.
      res.setHeader('Content-Type', 'application/sql; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="vault-backup-${stamp.slice(0, 16)}.sql"`
      );
      await db.dumpToStream(res);
      res.end();
    } catch (err) {
      console.error('Manual backup download failed:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Could not create a backup right now. Please try again.' });
      } else {
        // Headers (and maybe some of the dump) are already on the wire —
        // too late for a JSON error body, just stop the response.
        res.end();
      }
    }
  });

  app.get('/api/backup/status', requireAuth, (req, res) => {
    let files = [];
    try {
      files = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => /^vault-\d{4}-\d{2}-\d{2}\.sql$/.test(f))
        .sort();
    } catch (e) {
      // no backups directory yet — that's fine, just means none have run
    }

    let latest = null;
    if (files.length) {
      const name = files[files.length - 1];
      const stat = fs.statSync(path.join(BACKUP_DIR, name));
      latest = { fileName: name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    }

    res.json({
      automaticBackups: { count: files.length, keepDays: 30, latest },
      offsite: offsiteBackupConfigured(),
    });
  });
};