// =====================================================================
//  VAULT  -  STEP 5: DASHBOARD, NOTIFICATIONS, REMINDERS, SETTINGS, SEARCH
// =====================================================================
//  Home page
//    GET    /api/dashboard          everything the home page needs in one call:
//                                   totals, "due today", overdue, upcoming,
//                                   reminders, notification list, recent activity
//  Reminders (your father's own notes/alerts)
//    GET    /api/reminders          list (?status=pending|done|all)
//    POST   /api/reminders          add
//    PATCH  /api/reminders/:id      edit / mark done / reopen
//    DELETE /api/reminders/:id      remove (a copy is kept in the audit log)
//  Settings (editable from inside the app)
//    GET    /api/settings
//    PATCH  /api/settings
//  Search
//    GET    /api/search?q=          borrowers + reminders in one box
//
//  Uses the interest engine from routes/payments.js.
//
//  NOTE: every db call here goes through lib/db.js's Turso-backed
//  wrapper now, so every db.prepare(...).get()/.all()/.run() call — and
//  every route/helper that touches one — needs to be async + awaited.
//  That's the main thing that changed in this file for the Turso move.
// =====================================================================
'use strict';

module.exports = function (ctx) {
  const { app, db, requireAuth, audit, HttpError, toRupees, isDate, todayStr, addDays, addMonths } = ctx;

  const bad = (msg) => new HttpError(400, msg);
  const notFound = (what) => new HttpError(404, `${what} not found.`);
  const asObject = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});

  // The interest engine lives in payments.js; it is looked up when a request arrives
  const engine = () => {
    if (!ctx.interest) throw new HttpError(500, 'Interest engine is missing. Make sure routes/payments.js is present.');
    return ctx.interest;
  };

  // A setting that controls the "upcoming" list on the home page. This
  // runs once at startup (route files are require()'d synchronously),
  // so it's fired-and-forgotten rather than awaited — any error just
  // gets logged instead of crashing the boot sequence.
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('upcoming_days', '7')")
    .run()
    .catch((err) => console.error('dashboard.js: failed to seed upcoming_days setting:', err.message));

  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function parseId(value, label = 'ID') {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw bad(`Invalid ${label}.`);
    return n;
  }
  function cleanText(value, label, max, required = false) {
    if (value === undefined) return undefined;
    if (value === null || (typeof value === 'string' && value.trim() === '')) {
      if (required) throw bad(`${label} is required.`);
      return null;
    }
    if (typeof value !== 'string') throw bad(`${label} must be text.`);
    const t = value.trim();
    if (t.length > max) throw bad(`${label} is too long (maximum ${max} characters).`);
    return t;
  }
  function cleanDate(value, label, required = false) {
    if (value === undefined) return undefined;
    if (value === null || value === '') {
      if (required) throw bad(`${label} is required.`);
      return null;
    }
    if (!isDate(value)) throw bad(`${label} must be a valid date (YYYY-MM-DD).`);
    return value;
  }
  const likeEscape = (s) => s.replace(/[\\%_]/g, '\\$&');

  // -------------------------------------------------------------------
  // SETTINGS
  // -------------------------------------------------------------------
  const SETTINGS = {
    businessName:        { key: 'business_name',         def: 'My Lending Business' },
    currencySymbol:      { key: 'currency_symbol',       def: 'Rs' },
    defaultInterestRate: { key: 'default_interest_rate', def: '2' },
    defaultRatePeriod:   { key: 'default_rate_period',   def: 'monthly' },
    upcomingDays:        { key: 'upcoming_days',         def: '7' },
    theme:               { key: 'theme',                 def: 'dark' },
  };

  async function readSettings() {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const out = {};
    for (const [name, spec] of Object.entries(SETTINGS)) {
      const v = byKey[spec.key] ?? spec.def;
      out[name] = name === 'defaultInterestRate' || name === 'upcomingDays' ? Number(v) : v;
    }
    return out;
  }

  function validateSetting(name, value) {
    switch (name) {
      case 'businessName': {
        const v = cleanText(value, 'Business name', 80, true);
        return v;
      }
      case 'currencySymbol':
        return cleanText(value, 'Currency symbol', 5, true);
      case 'defaultInterestRate': {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0 || n > 1000) throw bad('Default interest rate must be between 0 and 1000.');
        return String(n);
      }
      case 'defaultRatePeriod':
        if (!['daily', 'monthly', 'yearly'].includes(value)) throw bad('Rate period must be daily, monthly or yearly.');
        return value;
      case 'upcomingDays': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 60) throw bad('Upcoming days must be a whole number from 1 to 60.');
        return String(n);
      }
      case 'theme':
        if (!['dark', 'light', 'system'].includes(value)) throw bad('Theme must be dark, light or system.');
        return value;
      default:
        return undefined;
    }
  }

  app.get('/api/settings', requireAuth, async (req, res) => {
    res.json({ settings: await readSettings() });
  });

  app.patch('/api/settings', requireAuth, async (req, res) => {
    const body = asObject(req.body);
    const updates = [];
    for (const name of Object.keys(SETTINGS)) {
      if (name in body) updates.push([SETTINGS[name].key, validateSetting(name, body[name])]);
    }
    await db.transaction(async () => {
      for (const [key, value] of updates) {
        await db.prepare(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
        ).run(key, value);
      }
    })();
    res.json({ settings: await readSettings() });
  });

  // -------------------------------------------------------------------
  // REMINDERS
  // -------------------------------------------------------------------
  const REMINDER_SELECT = `
    SELECT r.*, b.full_name AS borrower_name
      FROM reminders r LEFT JOIN borrowers b ON b.id = r.borrower_id`;

  function reminderOut(r) {
    return {
      id: r.id,
      borrowerId: r.borrower_id,
      borrowerName: r.borrower_name || null,
      loanId: r.loan_id,
      title: r.title,
      details: r.details,
      remindOn: r.remind_on,
      isDone: !!r.is_done,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  // Reminders belong to the account that created them, same as borrowers.
  const getReminder = (id, ownerId) => db.prepare(`${REMINDER_SELECT} WHERE r.id = ? AND r.owner_id = ?`).get(id, ownerId);
  const getReminderRaw = (id, ownerId) => db.prepare('SELECT * FROM reminders WHERE id = ? AND owner_id = ?').get(id, ownerId);

  // Work out and check borrower/loan links (only within the caller's own records)
  async function resolveLinks(borrowerId, loanId, ownerId) {
    let b = borrowerId;
    let l = loanId;
    if (l) {
      const loan = await db
        .prepare('SELECT l.id, l.borrower_id FROM loans l JOIN borrowers ob ON ob.id = l.borrower_id WHERE l.id = ? AND ob.owner_id = ?')
        .get(l, ownerId);
      if (!loan) throw bad('That loan does not exist.');
      if (b && b !== loan.borrower_id) throw bad('That loan does not belong to that borrower.');
      b = loan.borrower_id;
    }
    if (b && !(await db.prepare('SELECT 1 FROM borrowers WHERE id = ? AND owner_id = ?').get(b, ownerId))) throw bad('That borrower does not exist.');
    return { borrowerId: b || null, loanId: l || null };
  }

  app.get('/api/reminders', requireAuth, async (req, res) => {
    const status = ['pending', 'done', 'all'].includes(req.query.status) ? req.query.status : 'pending';
    const from = cleanDate(req.query.from || undefined, 'from');
    const to = cleanDate(req.query.to || undefined, 'to');
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);

    const where = ['r.owner_id = @ownerId'];
    const params = { limit, ownerId: req.user.id };
    if (status !== 'all') { where.push('r.is_done = @done'); params.done = status === 'done' ? 1 : 0; }
    if (from) { where.push('r.remind_on >= @from'); params.from = from; }
    if (to) { where.push('r.remind_on <= @to'); params.to = to; }
    if (req.query.borrowerId) { where.push('r.borrower_id = @borrowerId'); params.borrowerId = parseId(req.query.borrowerId, 'borrower ID'); }

    const order = status === 'done' ? 'r.remind_on DESC, r.id DESC' : 'r.remind_on ASC, r.id ASC';
    const rows = await db
      .prepare(`${REMINDER_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT @limit`)
      .all(params);
    res.json({ reminders: rows.map(reminderOut) });
  });

  app.post('/api/reminders', requireAuth, async (req, res) => {
    const body = asObject(req.body);
    const title = cleanText(body.title, 'Title', 200, true);
    const details = cleanText(body.details, 'Details', 1000) ?? null;
    const remindOn = cleanDate(body.remindOn, 'Reminder date', true);
    const links = await resolveLinks(
      body.borrowerId ? parseId(body.borrowerId, 'borrower ID') : null,
      body.loanId ? parseId(body.loanId, 'loan ID') : null,
      req.user.id
    );

    const id = await db.transaction(async () => {
      const info = await db
        .prepare('INSERT INTO reminders (borrower_id, loan_id, title, details, remind_on, owner_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(links.borrowerId, links.loanId, title, details, remindOn, req.user.id);
      const newId = Number(info.lastInsertRowid);
      await audit(req.user.id, 'reminders', newId, 'create', null, await getReminderRaw(newId, req.user.id));
      return newId;
    })();
    res.status(201).json({ reminder: reminderOut(await getReminder(id, req.user.id)) });
  });

  app.patch('/api/reminders/:id', requireAuth, async (req, res) => {
    const id = parseId(req.params.id, 'reminder ID');
    const body = asObject(req.body);
    const before = await getReminderRaw(id, req.user.id);
    if (!before) throw notFound('Reminder');

    const data = {};
    if ('title' in body) data.title = cleanText(body.title, 'Title', 200, true);
    if ('details' in body) data.details = cleanText(body.details, 'Details', 1000);
    if ('remindOn' in body) data.remind_on = cleanDate(body.remindOn, 'Reminder date', true);
    if ('isDone' in body) {
      if (typeof body.isDone !== 'boolean') throw bad('isDone must be true or false.');
      data.is_done = body.isDone ? 1 : 0;
    }
    if ('borrowerId' in body || 'loanId' in body) {
      const bId = 'borrowerId' in body ? (body.borrowerId ? parseId(body.borrowerId, 'borrower ID') : null) : before.borrower_id;
      const lId = 'loanId' in body ? (body.loanId ? parseId(body.loanId, 'loan ID') : null) : before.loan_id;
      // if only the borrower changed, the old loan link no longer applies
      const links = await resolveLinks(bId, 'borrowerId' in body && !('loanId' in body) ? null : lId, req.user.id);
      data.borrower_id = links.borrowerId;
      data.loan_id = links.loanId;
    }

    const changed = Object.keys(data).filter((c) => (before[c] ?? null) !== data[c]);
    if (changed.length) {
      await db.transaction(async () => {
        const values = { id };
        for (const c of changed) values[c] = data[c];
        await db.prepare(`UPDATE reminders SET ${changed.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run(values);
        await audit(req.user.id, 'reminders', id, 'update', before, await getReminderRaw(id, req.user.id));
      })();
    }
    res.json({ reminder: reminderOut(await getReminder(id, req.user.id)) });
  });

  // Reminders are personal notes (not money records), so they can be removed.
  // A full copy is still kept in the audit log.
  app.delete('/api/reminders/:id', requireAuth, async (req, res) => {
    const id = parseId(req.params.id, 'reminder ID');
    const before = await getReminderRaw(id, req.user.id);
    if (!before) throw notFound('Reminder');
    await db.transaction(async () => {
      await db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
      await audit(req.user.id, 'reminders', id, 'archive', before, null);
    })();
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------
  // DASHBOARD
  // -------------------------------------------------------------------
  const monthlyEquivalent = (loan, principal) => {
    const factor = loan.rate_period === 'monthly' ? 1 : loan.rate_period === 'yearly' ? 1 / 12 : 30;
    return Math.round((principal * loan.interest_rate * factor) / 100);
  };

  async function sumByType(from, to, ownerId) {
    const rows = await db
      .prepare(
        `SELECT t.type, COALESCE(SUM(t.amount), 0) AS s
           FROM transactions t
           JOIN loans l ON l.id = t.loan_id
           JOIN borrowers b ON b.id = l.borrower_id
          WHERE t.is_voided = 0 AND t.txn_date >= ? AND t.txn_date <= ? AND b.owner_id = ?
          GROUP BY t.type`
      )
      .all(from, to, ownerId);
    const m = Object.fromEntries(rows.map((r) => [r.type, r.s]));
    return {
      lent: (m.disbursement || 0) + (m.topup || 0),
      principalRepaid: m.principal_payment || 0,
      interestReceived: m.interest_payment || 0,
    };
  }

  app.get('/api/dashboard', requireAuth, async (req, res) => {
    const { computeInterest } = engine();
    const today = todayStr();
    const upcomingDays = (await readSettings()).upcomingDays;
    const upcomingEnd = addDays(today, upcomingDays);
    const monthStart = `${today.slice(0, 8)}01`;
    const prevMonthStart = addMonths(monthStart, -1);
    const prevMonthEnd = addDays(monthStart, -1);

    const loans = await db
      .prepare(
        `SELECT l.*, s.outstanding_principal, b.full_name AS borrower_name, b.phone AS borrower_phone
           FROM loans l
           JOIN loan_summary s ON s.loan_id = l.id
           JOIN borrowers b ON b.id = l.borrower_id
          WHERE l.status = 'active' AND b.owner_id = ?`
      )
      .all(req.user.id);

    let principalOut = 0;
    let pendingTotal = 0;
    let monthlyExpected = 0;
    const dueToday = [];
    const overdue = [];
    const upcoming = [];

    const dueItem = (l, it, extra) => ({
      loanId: l.id,
      borrowerId: l.borrower_id,
      borrowerName: l.borrower_name,
      borrowerPhone: l.borrower_phone,
      cycleNumber: l.cycle_number,
      dueDate: l.next_due_date,
      expectedAmount: toRupees(l.expected_amount),
      outstandingPrincipal: toRupees(l.outstanding_principal),
      interestRate: l.interest_rate,
      ratePeriod: l.rate_period,
      interestPending: toRupees(Math.max(it.pending, 0)),
      monthlyInterest: toRupees(monthlyEquivalent(l, l.outstanding_principal)),
      ...extra,
    });

    for (const l of loans) {
      principalOut += l.outstanding_principal;
      monthlyExpected += monthlyEquivalent(l, l.outstanding_principal);

      const now = computeInterest(l, today);
      if (now.pending > 0) pendingTotal += now.pending;

      if (!l.next_due_date || l.next_due_date > upcomingEnd) continue;
      if (l.next_due_date < today) {
        overdue.push(dueItem(l, now, { daysOverdue: daysBetween(l.next_due_date, today) }));
      } else if (l.next_due_date === today) {
        dueToday.push(dueItem(l, now, {}));
      } else {
        upcoming.push(dueItem(l, computeInterest(l, l.next_due_date), { daysUntil: daysBetween(today, l.next_due_date) }));
      }
    }
    overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.borrowerName.localeCompare(b.borrowerName));
    dueToday.sort((a, b) => a.borrowerName.localeCompare(b.borrowerName));
    upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.borrowerName.localeCompare(b.borrowerName));

    const defaulted = await db
      .prepare(
        `SELECT COUNT(*) AS c, COALESCE(SUM(s.outstanding_principal), 0) AS p
           FROM loan_summary s JOIN borrowers b ON b.id = s.borrower_id
          WHERE s.status = 'defaulted' AND b.owner_id = ?`
      )
      .get(req.user.id);
    const lifetime = await db
      .prepare(
        `SELECT COALESCE(SUM(s.total_lent), 0) AS lent, COALESCE(SUM(s.interest_received), 0) AS interest
           FROM loan_summary s JOIN borrowers b ON b.id = s.borrower_id
          WHERE b.owner_id = ?`
      )
      .get(req.user.id);
    const borrowerCounts = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM borrowers WHERE is_archived = 0 AND owner_id = @ownerId) AS total,
                (SELECT COUNT(DISTINCT l.borrower_id) FROM loans l JOIN borrowers b ON b.id = l.borrower_id
                  WHERE l.status = 'active' AND b.owner_id = @ownerId) AS withActiveLoan`
      )
      .get({ ownerId: req.user.id });

    const thisMonth = await sumByType(monthStart, today, req.user.id);
    const lastMonth = await sumByType(prevMonthStart, prevMonthEnd, req.user.id);

    // Reminders that need attention now
    const reminderRows = await db
      .prepare(`${REMINDER_SELECT} WHERE r.owner_id = ? AND r.is_done = 0 AND r.remind_on <= ? ORDER BY r.remind_on ASC, r.id ASC`)
      .all(req.user.id, today);
    const remindersDue = reminderRows.map(reminderOut);
    const upcomingReminders = (
      await db
        .prepare('SELECT COUNT(*) AS c FROM reminders WHERE owner_id = ? AND is_done = 0 AND remind_on > ? AND remind_on <= ?')
        .get(req.user.id, today, upcomingEnd)
    ).c;

    // One combined list for the notification bell / home-page banner
    const notifications = [
      ...overdue.map((d) => ({
        type: 'overdue',
        severity: 'high',
        loanId: d.loanId,
        borrowerId: d.borrowerId,
        date: d.dueDate,
        message: `${d.borrowerName} — payment overdue by ${plural(d.daysOverdue, 'day')}`,
      })),
      ...dueToday.map((d) => ({
        type: 'due_today',
        severity: 'medium',
        loanId: d.loanId,
        borrowerId: d.borrowerId,
        date: d.dueDate,
        message: `${d.borrowerName} — payment due today`,
      })),
      ...remindersDue.map((r) => ({
        type: 'reminder',
        severity: r.remindOn < today ? 'high' : 'medium',
        reminderId: r.id,
        borrowerId: r.borrowerId,
        loanId: r.loanId,
        date: r.remindOn,
        message: r.title,
      })),
    ];

    const activity = (
      await db
        .prepare(
          `SELECT t.*, l.borrower_id, b.full_name AS borrower_name
             FROM transactions t
             JOIN loans l ON l.id = t.loan_id
             JOIN borrowers b ON b.id = l.borrower_id
            WHERE t.is_voided = 0 AND b.owner_id = ?
            ORDER BY t.txn_date DESC, t.id DESC LIMIT 10`
        )
        .all(req.user.id)
    ).map((t) => ({
      id: t.id,
      loanId: t.loan_id,
      borrowerId: t.borrower_id,
      borrowerName: t.borrower_name,
      type: t.type,
      amount: toRupees(t.amount),
      date: t.txn_date,
      method: t.method,
      note: t.note,
    }));

    res.json({
      today,
      monthStart,
      summary: {
        principalOutstanding: toRupees(principalOut),
        expectedMonthlyInterest: toRupees(monthlyExpected),
        interestPending: toRupees(pendingTotal),
        activeLoans: loans.length,
        activeBorrowers: borrowerCounts.withActiveLoan,
        totalBorrowers: borrowerCounts.total,
        defaultedLoans: defaulted.c,
        defaultedPrincipal: toRupees(defaulted.p),
        totalLentAllTime: toRupees(lifetime.lent),
        interestEarnedAllTime: toRupees(lifetime.interest),
        thisMonth: {
          lent: toRupees(thisMonth.lent),
          principalRepaid: toRupees(thisMonth.principalRepaid),
          interestReceived: toRupees(thisMonth.interestReceived),
        },
        lastMonth: {
          lent: toRupees(lastMonth.lent),
          principalRepaid: toRupees(lastMonth.principalRepaid),
          interestReceived: toRupees(lastMonth.interestReceived),
        },
      },
      dueToday,
      overdue,
      upcoming,
      upcomingDays,
      reminders: { due: remindersDue, upcomingCount: upcomingReminders },
      notifications,
      counts: {
        dueToday: dueToday.length,
        overdue: overdue.length,
        reminders: remindersDue.length,
        total: notifications.length,
      },
      recentActivity: activity,
    });
  });

  // -------------------------------------------------------------------
  // SEARCH  (one box for the whole app)
  // -------------------------------------------------------------------
  app.get('/api/search', requireAuth, async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 1) return res.json({ borrowers: [], reminders: [] });
    if (q.length > 100) throw bad('Search text is too long.');

    const like = `%${likeEscape(q)}%`;
    const digitsOnly = q.replace(/[\s-]/g, '');
    const digits = digitsOnly ? `%${likeEscape(digitsOnly)}%` : like;   // ignore spaces/dashes when matching phone numbers
    const stripped = (col) => `REPLACE(REPLACE(${col}, ' ', ''), '-', '')`;

    const borrowers = (
      await db
        .prepare(
          `SELECT b.id, b.full_name, b.phone, b.city, b.is_archived,
                  (SELECT l.id FROM loans l WHERE l.borrower_id = b.id AND l.status = 'active' LIMIT 1) AS active_loan_id,
                  COALESCE((SELECT SUM(s.outstanding_principal) FROM loan_summary s
                             WHERE s.borrower_id = b.id AND s.status = 'active'), 0) AS outstanding_principal,
                  (SELECT MIN(l.next_due_date) FROM loans l
                    WHERE l.borrower_id = b.id AND l.status = 'active') AS next_due_date
             FROM borrowers b
            WHERE b.owner_id = @ownerId
              AND (b.full_name LIKE @like ESCAPE '\\'
               OR b.city LIKE @like ESCAPE '\\'
               OR b.id_proof_number LIKE @like ESCAPE '\\'
               OR b.guarantor_name LIKE @like ESCAPE '\\'
               OR ${stripped('b.phone')} LIKE @digits ESCAPE '\\'
               OR ${stripped('b.alt_phone')} LIKE @digits ESCAPE '\\')
            ORDER BY b.is_archived ASC, b.full_name COLLATE NOCASE ASC
            LIMIT 10`
        )
        .all({ like, digits, ownerId: req.user.id })
    ).map((b) => ({
      id: b.id,
      fullName: b.full_name,
      phone: b.phone,
      city: b.city,
      isArchived: !!b.is_archived,
      activeLoanId: b.active_loan_id,
      outstandingPrincipal: toRupees(b.outstanding_principal),
      nextDueDate: b.next_due_date,
    }));

    const reminders = (
      await db
        .prepare(`${REMINDER_SELECT} WHERE r.owner_id = @ownerId AND (r.title LIKE @like ESCAPE '\\' OR r.details LIKE @like ESCAPE '\\')
                  ORDER BY r.is_done ASC, r.remind_on ASC LIMIT 5`)
        .all({ like, ownerId: req.user.id })
    ).map(reminderOut);

    res.json({ borrowers, reminders });
  });
};