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
    let tmpPath = null;
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      // No leading dot: Express's static/sendFile layer treats dotfiles
      // specially and will refuse to serve them.
      tmpPath = path.join(BACKUP_DIR, `manual-${stamp}.db`);
      await db.backup(tmpPath);
      res.download(tmpPath, `vault-backup-${stamp.slice(0, 16)}.db`, (err) => {
        fs.unlink(tmpPath, () => {});
        if (err && !res.headersSent) {
          res.status(500).json({ error: 'Could not send the backup file.' });
        }
      });
    } catch (err) {
      if (tmpPath) fs.unlink(tmpPath, () => {});
      console.error('Manual backup download failed:', err.message);
      res.status(500).json({ error: 'Could not create a backup right now. Please try again.' });
    }
  });

  app.get('/api/backup/status', requireAuth, (req, res) => {
    let files = [];
    try {
      files = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => /^vault-\d{4}-\d{2}-\d{2}\.db$/.test(f))
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