// =====================================================================
//  VAULT  -  STEP 3: BORROWER + LOAN CYCLE API
// =====================================================================
//  Borrowers
//    GET    /api/borrowers                 list + search + sort
//    POST   /api/borrowers                 add a borrower
//    GET    /api/borrowers/:id             full details + all loan cycles
//    PATCH  /api/borrowers/:id             edit ANY detail
//    POST   /api/borrowers/:id/archive     hide a borrower (nothing is deleted)
//    POST   /api/borrowers/:id/restore     bring them back
//
//  Loan cycles
//    POST   /api/borrowers/:id/loans       start a new loan cycle
//    GET    /api/loans                     list loans (filter by status / due date)
//    GET    /api/loans/:id                 loan details + full transaction history
//    PATCH  /api/loans/:id                 edit rate, due date, frequency, notes...
//    POST   /api/loans/:id/status          close / reopen / mark defaulted
//
//  Interest is simple interest on the outstanding PRINCIPAL only
//  (no interest-on-interest). The calculation itself comes in Step 4.
//  Every create/edit is saved in the audit log. Nothing is ever deleted.
// =====================================================================
'use strict';

module.exports = function ({ app, db, requireAuth, audit, HttpError, toPaise, toRupees, isDate, todayStr, addDays, addMonths }) {
  // -------------------------------------------------------------------
  // VALIDATION HELPERS
  // -------------------------------------------------------------------
  const bad = (msg) => new HttpError(400, msg);
  const notFound = (what) => new HttpError(404, `${what} not found.`);
  const asObject = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});

  const RATE_PERIODS = ['daily', 'monthly', 'yearly'];
  const INTEREST_TYPES = ['simple', 'compound'];
  const FREQUENCIES = ['daily', 'weekly', 'monthly', 'custom'];
  const METHODS = ['cash', 'upi', 'bank_transfer', 'cheque', 'other'];
  const STATUSES = ['active', 'closed', 'defaulted'];

  function parseId(value, label = 'ID') {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw bad(`Invalid ${label}.`);
    return n;
  }

  // undefined -> "not sent" (returns undefined); null/"" -> empty (returns null)
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

  function cleanNumber(value, label, { min, max, required = false } = {}) {
    if (value === undefined) return undefined;
    if (value === null || value === '') {
      if (required) throw bad(`${label} is required.`);
      return null;
    }
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) throw bad(`${label} must be a number.`);
    if (min !== undefined && n < min) throw bad(`${label} must be at least ${min}.`);
    if (max !== undefined && n > max) throw bad(`${label} must be at most ${max}.`);
    return n;
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

  function cleanEnum(value, label, allowed, required = false) {
    if (value === undefined) return undefined;
    if (value === null || value === '') {
      if (required) throw bad(`${label} is required.`);
      return null;
    }
    if (!allowed.includes(value)) throw bad(`${label} must be one of: ${allowed.join(', ')}.`);
    return value;
  }

  // -------------------------------------------------------------------
  // OUTPUT HELPERS (database rows -> clean JSON for the website)
  // -------------------------------------------------------------------
  const camelKey = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

  function borrowerOut(r) {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[camelKey(k)] = v;
    o.isArchived = !!r.is_archived;
    if ('outstanding_principal' in r) o.outstandingPrincipal = toRupees(r.outstanding_principal);
    return o;
  }

  const LOAN_SELECT = `
    SELECT l.*, s.total_lent, s.principal_repaid, s.outstanding_principal, s.interest_received
      FROM loans l
      JOIN loan_summary s ON s.loan_id = l.id`;

  function loanOut(r) {
    const o = {
      id: r.id,
      borrowerId: r.borrower_id,
      cycleNumber: r.cycle_number,
      startDate: r.start_date,
      interestRate: r.interest_rate,
      ratePeriod: r.rate_period,
      interestType: r.interest_type,
      paymentFrequency: r.payment_frequency,
      nextDueDate: r.next_due_date,
      expectedAmount: toRupees(r.expected_amount),
      status: r.status,
      closedDate: r.closed_date,
      notes: r.notes,
      totalLent: toRupees(r.total_lent),
      principalRepaid: toRupees(r.principal_repaid),
      outstandingPrincipal: toRupees(r.outstanding_principal),
      interestReceived: toRupees(r.interest_received),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
    if ('borrower_name' in r) {
      o.borrowerName = r.borrower_name;
      o.borrowerPhone = r.borrower_phone;
    }
    return o;
  }

  function txnOut(t) {
    return {
      id: t.id,
      loanId: t.loan_id,
      type: t.type,
      amount: toRupees(t.amount),
      date: t.txn_date,
      method: t.method,
      referenceNo: t.reference_no,
      interestFrom: t.interest_from,
      interestTo: t.interest_to,
      note: t.note,
      isVoided: !!t.is_voided,
      voidedReason: t.voided_reason,
      createdAt: t.created_at,
    };
  }

  // Every borrower belongs to the account that created it (owner_id), so
  // these lookups double as the ownership check: a borrower/loan that
  // exists but belongs to someone else comes back exactly like it doesn't
  // exist, which is what keeps one account's records invisible to another.
  const getBorrowerRow = (id, ownerId) => db.prepare('SELECT * FROM borrowers WHERE id = ? AND owner_id = ?').get(id, ownerId);
  const getLoanRow = (id, ownerId) =>
    db.prepare(`${LOAN_SELECT} JOIN borrowers ob ON ob.id = l.borrower_id WHERE l.id = ? AND ob.owner_id = ?`).get(id, ownerId);

  async function borrowerDetail(id, ownerId) {
    const b = await getBorrowerRow(id, ownerId);
    if (!b) throw notFound('Borrower');
    const rawLoans = await db.prepare(`${LOAN_SELECT} WHERE l.borrower_id = ? ORDER BY l.cycle_number DESC`).all(id);
    const activeOutstanding = rawLoans
      .filter((l) => l.status === 'active')
      .reduce((sum, l) => sum + l.outstanding_principal, 0);
    const interestReceived = rawLoans.reduce((sum, l) => sum + l.interest_received, 0);
    return {
      ...borrowerOut(b),
      totals: {
        outstandingPrincipal: toRupees(activeOutstanding),
        interestReceived: toRupees(interestReceived),
        totalCycles: rawLoans.length,
      },
      loans: rawLoans.map(loanOut),
    };
  }

  // -------------------------------------------------------------------
  // BORROWERS
  // -------------------------------------------------------------------
  const BORROWER_FIELDS = {
    fullName:          { col: 'full_name',          label: 'Full name',           max: 100, required: true },
    fatherOrSpouse:    { col: 'father_or_spouse',   label: "Father's/spouse name", max: 100 },
    phone:             { col: 'phone',              label: 'Phone',               max: 20, kind: 'phone' },
    altPhone:          { col: 'alt_phone',          label: 'Alternate phone',     max: 20, kind: 'phone' },
    email:             { col: 'email',              label: 'Email',               max: 120, kind: 'email' },
    address:           { col: 'address',            label: 'Address',             max: 500 },
    city:              { col: 'city',               label: 'City',                max: 80 },
    occupation:        { col: 'occupation',         label: 'Occupation',          max: 100 },
    idProofType:       { col: 'id_proof_type',      label: 'ID proof type',       max: 40 },
    idProofNumber:     { col: 'id_proof_number',    label: 'ID proof number',     max: 40 },
    guarantorName:     { col: 'guarantor_name',     label: 'Guarantor name',      max: 100 },
    guarantorPhone:    { col: 'guarantor_phone',    label: 'Guarantor phone',     max: 20, kind: 'phone' },
    guarantorAddress:  { col: 'guarantor_address',  label: 'Guarantor address',   max: 500 },
    collateralDetails: { col: 'collateral_details', label: 'Collateral details',  max: 1000 },
    notes:             { col: 'notes',              label: 'Notes',               max: 2000 },
  };

  function parseBorrowerBody(body, partial) {
    const out = {};
    for (const [key, spec] of Object.entries(BORROWER_FIELDS)) {
      if (!(key in body)) {
        if (!partial && spec.required) throw bad(`${spec.label} is required.`);
        continue;
      }
      const v = cleanText(body[key], spec.label, spec.max, !!spec.required);
      if (v && spec.kind === 'phone' && !/^[0-9+()\-\s]{5,20}$/.test(v)) {
        throw bad(`${spec.label} looks invalid. Use digits, spaces, + and - only.`);
      }
      if (v && spec.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        throw bad(`${spec.label} looks invalid.`);
      }
      out[spec.col] = v;
    }
    return out;
  }

  // List / search borrowers, each with a quick money summary
  app.get('/api/borrowers', requireAuth, async (req, res) => {
    const archived = req.query.archived === '1' ? 1 : req.query.archived === 'all' ? null : 0;
    const search = String(req.query.search || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const SORTS = {
      name:   'b.full_name COLLATE NOCASE ASC',
      recent: 'b.created_at DESC, b.id DESC',
      due:    'next_due_date IS NULL, next_due_date ASC, b.full_name COLLATE NOCASE ASC',
    };
    const sortSql = Object.prototype.hasOwnProperty.call(SORTS, req.query.sort) ? SORTS[req.query.sort] : SORTS.name;

    const where = ['b.owner_id = @ownerId'];
    const params = { ownerId: req.user.id };
    if (archived !== null) {
      where.push('b.is_archived = @archived');
      params.archived = archived;
    }
    if (search) {
      where.push(`(b.full_name LIKE @q ESCAPE '\\' OR b.phone LIKE @q ESCAPE '\\'
                   OR b.alt_phone LIKE @q ESCAPE '\\' OR b.city LIKE @q ESCAPE '\\')`);
      params.q = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (await db.prepare(`SELECT COUNT(*) AS c FROM borrowers b ${whereSql}`).get(params)).c;
    const rows = await db
      .prepare(
        `SELECT b.*,
           (SELECT COUNT(*) FROM loans l WHERE l.borrower_id = b.id) AS total_cycles,
           (SELECT COUNT(*) FROM loans l WHERE l.borrower_id = b.id AND l.status = 'active') AS active_loans,
           COALESCE((SELECT SUM(s.outstanding_principal) FROM loan_summary s
                      WHERE s.borrower_id = b.id AND s.status = 'active'), 0) AS outstanding_principal,
           (SELECT MIN(l.next_due_date) FROM loans l
             WHERE l.borrower_id = b.id AND l.status = 'active' AND l.next_due_date IS NOT NULL) AS next_due_date
         FROM borrowers b
         ${whereSql}
         ORDER BY ${sortSql}
         LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit, offset });

    res.json({ total, borrowers: rows.map(borrowerOut) });
  });

  app.post('/api/borrowers', requireAuth, async (req, res) => {
    const data = parseBorrowerBody(asObject(req.body), false);
    data.owner_id = req.user.id;
    const cols = Object.keys(data);

    const id = await db.transaction(async () => {
      const info = await db
        .prepare(`INSERT INTO borrowers (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`)
        .run(data);
      const newId = Number(info.lastInsertRowid);
      await audit(req.user.id, 'borrowers', newId, 'create', null, await getBorrowerRow(newId, req.user.id));
      return newId;
    })();

    res.status(201).json({ borrower: await borrowerDetail(id, req.user.id) });
  });

  app.get('/api/borrowers/:id', requireAuth, async (req, res) => {
    res.json({ borrower: await borrowerDetail(parseId(req.params.id, 'borrower ID'), req.user.id) });
  });

  app.patch('/api/borrowers/:id', requireAuth, async (req, res) => {
    const id = parseId(req.params.id, 'borrower ID');
    const before = await getBorrowerRow(id, req.user.id);
    if (!before) throw notFound('Borrower');

    const data = parseBorrowerBody(asObject(req.body), true);
    const changed = Object.keys(data).filter((c) => (before[c] ?? null) !== data[c]);

    if (changed.length) {
      await db.transaction(async () => {
        const sets = changed.map((c) => `${c} = @${c}`).join(', ');
        const values = { id };
        for (const c of changed) values[c] = data[c];
        await db.prepare(`UPDATE borrowers SET ${sets} WHERE id = @id`).run(values);
        await audit(req.user.id, 'borrowers', id, 'update', before, await getBorrowerRow(id, req.user.id));
      })();
    }
    res.json({ borrower: await borrowerDetail(id, req.user.id) });
  });

  app.post('/api/borrowers/:id/archive', requireAuth, async (req, res) => {
    const id = parseId(req.params.id, 'borrower ID');
    const before = await getBorrowerRow(id, req.user.id);
    if (!before) throw notFound('Borrower');
    if (before.is_archived) return res.json({ borrower: await borrowerDetail(id, req.user.id) });

    const active = (await db.prepare("SELECT COUNT(*) AS c FROM loans WHERE borrower_id = ? AND status = 'active'").get(id)).c;
    if (active > 0) {
      throw new HttpError(409, 'This borrower has an active loan. Close the loan before archiving.');
    }
    await db.transaction(async () => {
      await db.prepare('UPDATE borrowers SET is_archived = 1 WHERE id = ?').run(id);
      await audit(req.user.id, 'borrowers', id, 'archive', before, await getBorrowerRow(id, req.user.id));
    })();
    res.json({ borrower: await borrowerDetail(id, req.user.id) });
  });

  app.post('/api/borrowers/:id/restore', requireAuth, async (req, res) => {
    const id = parseId(req.params.id, 'borrower ID');
    const before = await getBorrowerRow(id, req.user.id);
    if (!before) throw notFound('Borrower');
    if (before.is_archived) {
      await db.transaction(async () => {
        await db.prepare('UPDATE borrowers SET is_archived = 0 WHERE id = ?').run(id);
        await audit(req.user.id, 'borrowers', id, 'restore', before, await getBorrowerRow(id, req.user.id));
      })();
    }
    res.json({ borrower: await borrowerDetail(id, req.user.id) });
  });

  // -------------------------------------------------------------------
  // LOAN CYCLES
  // -------------------------------------------------------------------
  const getSetting = async (key, fallback) => {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value !== null && row.value !== '' ? row.value : fallback;
  };

  function defaultDueDate(startDate, frequency) {
    if (frequency === 'daily') return addDays(startDate, 1);
    if (frequency === 'weekly') return addDays(startDate, 7);
    if (frequency === 'monthly') return addMonths(startDate, 1);
    return null; // custom: father sets it himself
  }

  // Start a new loan cycle (records the first disbursement automatically)
  app.post('/api/borrowers/:id/loans', requireAuth, async (req, res) => {
    const borrowerId = parseId(req.params.id, 'borrower ID');
    const body = asObject(req.body);

    const borrower = await getBorrowerRow(borrowerId, req.user.id);
    if (!borrower) throw notFound('Borrower');
    if (borrower.is_archived) throw new HttpError(409, 'This borrower is archived. Restore them first.');

    const principal = cleanNumber(body.principal, 'Principal amount', { min: 0.01, max: 1e9, required: true });
    const startDate = cleanDate(body.startDate, 'Start date') || todayStr();
    const interestRate =
      cleanNumber(body.interestRate, 'Interest rate', { min: 0, max: 1000 }) ??
      (Number(await getSetting('default_interest_rate', '2')) || 2);
    const ratePeriod =
      cleanEnum(body.ratePeriod, 'Rate period', RATE_PERIODS) ?? (await getSetting('default_rate_period', 'monthly'));
    const interestType = cleanEnum(body.interestType, 'Interest type', INTEREST_TYPES) ?? 'simple';
    const paymentFrequency = cleanEnum(body.paymentFrequency, 'Payment frequency', FREQUENCIES) ?? 'monthly';

    let nextDueDate = cleanDate(body.nextDueDate, 'Next due date');
    if (nextDueDate === undefined) nextDueDate = defaultDueDate(startDate, paymentFrequency);

    const expected = cleanNumber(body.expectedAmount, 'Expected payment', { min: 0.01, max: 1e9 });
    const notes = cleanText(body.notes, 'Notes', 2000) ?? null;
    const method = cleanEnum(body.method, 'Payment method', METHODS) ?? 'cash';
    const referenceNo = cleanText(body.referenceNo, 'Reference number', 60) ?? null;
    const txnNote = cleanText(body.note, 'Note', 500) ?? null;

    const loanId = await db.transaction(async () => {
      if (await db.prepare("SELECT 1 FROM loans WHERE borrower_id = ? AND status = 'active'").get(borrowerId)) {
        throw new HttpError(
          409,
          'This borrower already has an active loan cycle. Add a top-up to it, or close it before starting a new cycle.'
        );
      }
      const cycle = (await db
        .prepare('SELECT COALESCE(MAX(cycle_number), 0) + 1 AS n FROM loans WHERE borrower_id = ?')
        .get(borrowerId)).n;

      const info = await db
        .prepare(
          `INSERT INTO loans (borrower_id, cycle_number, start_date, interest_rate, rate_period, interest_type,
                              payment_frequency, next_due_date, expected_amount, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          borrowerId, cycle, startDate, interestRate, ratePeriod, interestType,
          paymentFrequency, nextDueDate, expected == null ? null : toPaise(expected), notes
        );
      const newLoanId = Number(info.lastInsertRowid);

      const txn = await db
        .prepare(
          `INSERT INTO transactions (loan_id, type, amount, txn_date, method, reference_no, note, created_by)
           VALUES (?, 'disbursement', ?, ?, ?, ?, ?, ?)`
        )
        .run(newLoanId, toPaise(principal), startDate, method, referenceNo, txnNote, req.user.id);

      await audit(req.user.id, 'loans', newLoanId, 'create', null, await db.prepare('SELECT * FROM loans WHERE id = ?').get(newLoanId));
      await audit(req.user.id, 'transactions', Number(txn.lastInsertRowid), 'create', null,
        await db.prepare('SELECT * FROM transactions WHERE id = ?').get(txn.lastInsertRowid));
      return newLoanId;
    })();

    res.status(201).json({ loan: loanOut(await getLoanRow(loanId, req.user.id)) });
  });

  // List loans (used by the home page and the loans screen)
  app.get('/api/loans', requireAuth, async (req, res) => {
    const status = cleanEnum(req.query.status || 'active', 'Status', [...STATUSES, 'all']);
    const dueBy = cleanDate(req.query.dueBy || undefined, 'dueBy');
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where = ['b.owner_id = @ownerId'];
    const params = { limit, offset, ownerId: req.user.id };
    if (status !== 'all') { where.push('l.status = @status'); params.status = status; }
    if (req.query.borrowerId) { where.push('l.borrower_id = @borrowerId'); params.borrowerId = parseId(req.query.borrowerId, 'borrower ID'); }
    if (dueBy) { where.push('l.next_due_date IS NOT NULL AND l.next_due_date <= @dueBy'); params.dueBy = dueBy; }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const rows = await db
      .prepare(
        `SELECT l.*, s.total_lent, s.principal_repaid, s.outstanding_principal, s.interest_received,
                b.full_name AS borrower_name, b.phone AS borrower_phone
           FROM loans l
           JOIN loan_summary s ON s.loan_id = l.id
           JOIN borrowers b ON b.id = l.borrower_id
           ${whereSql}
          ORDER BY l.next_due_date IS NULL, l.next_due_date ASC, b.full_name COLLATE NOCASE ASC
          LIMIT @limit OFFSET @offset`
      )
      .all(params);

    res.json({ loans: rows.map(loanOut) });
  });

  app.get('/api/loans/:id', requireAuth, async (req, res) => {
    const id = parseId(req.params.id, 'loan ID');
    const row = await getLoanRow(id, req.user.id);
    if (!row) throw notFound('Loan');
    const borrower = await getBorrowerRow(row.borrower_id, req.user.id);
    const txns = await db
      .prepare('SELECT * FROM transactions WHERE loan_id = ? ORDER BY txn_date DESC, id DESC')
      .all(id);

    res.json({
      loan: loanOut(row),
      borrower: { id: borrower.id, fullName: borrower.full_name, phone: borrower.phone },
      transactions: txns.map(txnOut),
    });
  });

  // Edit loan settings. (Amounts lent/repaid are changed through transactions in Step 4.)
  app.patch('/api/loans/:id', requireAuth, async (req, res) => {
    const id = parseId(req.params.id, 'loan ID');
    const body = asObject(req.body);
    const beforeView = await getLoanRow(id, req.user.id);
    if (!beforeView) throw notFound('Loan');

    const data = {};
    if ('interestRate' in body)     data.interest_rate = cleanNumber(body.interestRate, 'Interest rate', { min: 0, max: 1000, required: true });
    if ('ratePeriod' in body)       data.rate_period = cleanEnum(body.ratePeriod, 'Rate period', RATE_PERIODS, true);
    if ('interestType' in body)     data.interest_type = cleanEnum(body.interestType, 'Interest type', INTEREST_TYPES, true);
    if ('paymentFrequency' in body) data.payment_frequency = cleanEnum(body.paymentFrequency, 'Payment frequency', FREQUENCIES, true);
    if ('nextDueDate' in body)      data.next_due_date = cleanDate(body.nextDueDate, 'Next due date');
    if ('notes' in body)            data.notes = cleanText(body.notes, 'Notes', 2000);
    if ('expectedAmount' in body) {
      const v = cleanNumber(body.expectedAmount, 'Expected payment', { min: 0.01, max: 1e9 });
      data.expected_amount = v == null ? null : toPaise(v);
    }

    const changed = Object.keys(data).filter((c) => (beforeView[c] ?? null) !== data[c]);
    if (changed.length) {
      await db.transaction(async () => {
        const before = await db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
        const values = { id };
        for (const c of changed) values[c] = data[c];
        await db.prepare(`UPDATE loans SET ${changed.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run(values);
        await audit(req.user.id, 'loans', id, 'update', before, await db.prepare('SELECT * FROM loans WHERE id = ?').get(id));
      })();
    }
    res.json({ loan: loanOut(await getLoanRow(id, req.user.id)) });
  });

  // Close a cycle, reopen it, or mark it as defaulted
  app.post('/api/loans/:id/status', requireAuth, async (req, res) => {
    const id = parseId(req.params.id, 'loan ID');
    const body = asObject(req.body);
    const status = cleanEnum(body.status, 'Status', STATUSES, true);

    const row = await getLoanRow(id, req.user.id);
    if (!row) throw notFound('Loan');
    if (row.status === status) return res.json({ loan: loanOut(row) });

    if (status === 'active') {
      const other = await db
        .prepare("SELECT 1 FROM loans WHERE borrower_id = ? AND status = 'active' AND id <> ?")
        .get(row.borrower_id, id);
      if (other) throw new HttpError(409, 'This borrower already has another active loan cycle.');
    }

    let closedDate = null;
    if (status === 'closed') {
      if (row.outstanding_principal > 0 && body.force !== true) {
        throw new HttpError(409, 'Principal is still outstanding on this loan. Confirm if you want to close it anyway.', {
          needsConfirmation: true,
          outstandingPrincipal: toRupees(row.outstanding_principal),
        });
      }
      closedDate = cleanDate(body.closedDate, 'Closed date') || todayStr();
    }

    await db.transaction(async () => {
      const before = await db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
      await db.prepare('UPDATE loans SET status = ?, closed_date = ? WHERE id = ?').run(status, closedDate, id);
      await audit(req.user.id, 'loans', id, 'update', before, await db.prepare('SELECT * FROM loans WHERE id = ?').get(id));
    })();

    res.json({ loan: loanOut(await getLoanRow(id, req.user.id)) });
  });
};