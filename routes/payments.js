// =====================================================================
//  VAULT  -  STEP 4: PAYMENTS, TOP-UPS, INTEREST, STATEMENTS
// =====================================================================
//  Recording money
//    POST  /api/loans/:id/transactions     record a principal repayment,
//                                          an interest payment, or a top-up
//    GET   /api/transactions/:id           one entry
//    PATCH /api/transactions/:id           edit an entry
//    POST  /api/transactions/:id/void      cancel a wrong entry (kept, not deleted)
//    POST  /api/transactions/:id/restore   bring a voided entry back
//
//  Reading money
//    GET   /api/loans/:id/interest         interest earned / received / pending
//    GET   /api/loans/:id/statement        full ledger with running balances
//
//  HOW INTEREST IS CALCULATED
//   - Simple interest on the outstanding PRINCIPAL only (no interest on interest).
//   - The rate is "% per month" (each loan has its own rate).
//   - Time is counted on a month clock that starts on the loan's start date:
//     start 15 Jan -> 15 Feb is exactly 1 month, 15 Feb -> 15 Mar is exactly
//     1 month, and part-months are pro-rated by days.
//   - When the principal changes (top-up or repayment) the interest is split
//     into segments: each segment = principal x rate x months it was outstanding.
//   - Interest already received is subtracted to give the pending interest.
//   - Editing a loan's rate applies the new rate to the whole cycle. For a new
//     rate going forward, start a new loan cycle.
// =====================================================================
'use strict';

module.exports = function (ctx) {
  const { app, db, requireAuth, audit, HttpError, toPaise, toRupees, isDate, todayStr, addDays, addMonths } = ctx;

  // -------------------------------------------------------------------
  // VALIDATION HELPERS
  // -------------------------------------------------------------------
  const bad = (msg) => new HttpError(400, msg);
  const notFound = (what) => new HttpError(404, `${what} not found.`);
  const asObject = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? b : {});

  const ENTRY_TYPES = ['principal_payment', 'interest_payment', 'topup'];
  const METHODS = ['cash', 'upi', 'bank_transfer', 'cheque', 'other'];

  function parseId(value, label = 'ID') {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw bad(`Invalid ${label}.`);
    return n;
  }
  function cleanText(value, label, max) {
    if (value === undefined) return undefined;
    if (value === null || (typeof value === 'string' && value.trim() === '')) return null;
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
  function cleanDate(value, label) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (!isDate(value)) throw bad(`${label} must be a valid date (YYYY-MM-DD).`);
    return value;
  }
  function cleanEnum(value, label, allowed, required = false) {
    if (value === undefined || value === null || value === '') {
      if (required) throw bad(`${label} is required.`);
      return undefined;
    }
    if (!allowed.includes(value)) throw bad(`${label} must be one of: ${allowed.join(', ')}.`);
    return value;
  }

  // -------------------------------------------------------------------
  // INTEREST ENGINE
  // -------------------------------------------------------------------
  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

  // How many months (fractional) have passed between the loan start and date d
  function monthClock(start, d) {
    const [sy, sm] = start.split('-').map(Number);
    const [dy, dm] = d.split('-').map(Number);
    let k = Math.max(0, (dy - sy) * 12 + (dm - sm));
    while (k > 0 && addMonths(start, k) > d) k--;
    while (addMonths(start, k + 1) <= d) k++;
    const from = addMonths(start, k);
    const to = addMonths(start, k + 1);
    return k + daysBetween(from, d) / daysBetween(from, to);
  }

  function unitsBetween(period, start, from, to) {
    if (period === 'daily') return daysBetween(from, to);
    const months = monthClock(start, to) - monthClock(start, from);
    return period === 'yearly' ? months / 12 : months;
  }

  // Interest on a loan up to (and not including) the date asOf. All money in paise.
  // receivedUpTo: count interest payments made on or before this date.
  function computeInterest(loan, asOf, receivedUpTo) {
    const start = loan.start_date;
    const end = asOf < start ? start : asOf;
    const txns = db
      .prepare(
        `SELECT type, amount, txn_date FROM transactions
          WHERE loan_id = ? AND is_voided = 0
            AND type IN ('disbursement','topup','principal_payment') AND txn_date <= ?
          ORDER BY txn_date ASC, id ASC`
      )
      .all(loan.id, end);

    const segments = [];
    let balance = 0;
    let cursor = start;
    const addSegment = (from, to) => {
      if (balance > 0 && to > from) {
        const units = unitsBetween(loan.rate_period, start, from, to);
        segments.push({
          from, to, principal: balance, units,
          interest: Math.round((balance * loan.interest_rate * units) / 100),
        });
      }
    };
    for (const t of txns) {
      addSegment(cursor, t.txn_date);
      if (t.txn_date > cursor) cursor = t.txn_date;
      balance += t.type === 'principal_payment' ? -t.amount : t.amount;
    }
    addSegment(cursor, end);

    const accrued = segments.reduce((sum, s) => sum + s.interest, 0);
    const received = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
          WHERE loan_id = ? AND is_voided = 0 AND type = 'interest_payment' AND txn_date <= ?`
      )
      .get(loan.id, receivedUpTo || end).s;

    return { asOf: end, segments, accrued, received, pending: accrued - received, outstanding: balance };
  }

  // Let other route files (like the dashboard in Step 5) reuse the engine
  ctx.interest = { computeInterest };

  const unitLabel = (period) => (period === 'daily' ? 'days' : period === 'yearly' ? 'years' : 'months');

  function interestOut(loan, it) {
    const perMonthFactor = loan.rate_period === 'monthly' ? 1 : loan.rate_period === 'yearly' ? 1 / 12 : 30;
    return {
      loanId: loan.id,
      asOf: it.asOf,
      interestRate: loan.interest_rate,
      ratePeriod: loan.rate_period,
      outstandingPrincipal: toRupees(it.outstanding),
      accruedInterest: toRupees(it.accrued),
      interestReceived: toRupees(it.received),
      interestPending: toRupees(it.pending),   // negative means paid in advance
      interestPerMonthNow: toRupees(Math.round((it.outstanding * loan.interest_rate * perMonthFactor) / 100)),
      segments: it.segments.map((s) => ({
        from: s.from,
        to: s.to,
        principal: toRupees(s.principal),
        duration: Math.round(s.units * 10000) / 10000,
        durationUnit: unitLabel(loan.rate_period),
        interest: toRupees(s.interest),
      })),
    };
  }

  // -------------------------------------------------------------------
  // LOOKUPS + OUTPUT
  // -------------------------------------------------------------------
  // Scoped to the calling account: a loan/transaction that belongs to
  // someone else's borrower comes back as "not found", same as if it
  // never existed — that's what keeps accounts' records private.
  const getLoan = (id, ownerId) =>
    db.prepare('SELECT l.* FROM loans l JOIN borrowers b ON b.id = l.borrower_id WHERE l.id = ? AND b.owner_id = ?').get(id, ownerId);
  const getTxn = (id, ownerId) =>
    db.prepare(
      `SELECT t.* FROM transactions t
         JOIN loans l ON l.id = t.loan_id
         JOIN borrowers b ON b.id = l.borrower_id
        WHERE t.id = ? AND b.owner_id = ?`
    ).get(id, ownerId);
  const initialDisbursementId = (loanId) =>
    (db.prepare("SELECT id FROM transactions WHERE loan_id = ? AND type = 'disbursement' ORDER BY id LIMIT 1").get(loanId) || {}).id;

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
      updatedAt: t.updated_at,
    };
  }

  // Quick numbers for the loan after any change
  function snapshot(loanId, ownerId) {
    const l = db
      .prepare(
        `SELECT l.*, s.total_lent, s.principal_repaid, s.outstanding_principal, s.interest_received
           FROM loans l JOIN loan_summary s ON s.loan_id = l.id
           JOIN borrowers b ON b.id = l.borrower_id WHERE l.id = ? AND b.owner_id = ?`
      )
      .get(loanId, ownerId);
    const asOf = l.status === 'closed' && l.closed_date ? l.closed_date : todayStr();
    const it = computeInterest(l, asOf);
    return {
      id: l.id,
      status: l.status,
      nextDueDate: l.next_due_date,
      totalLent: toRupees(l.total_lent),
      principalRepaid: toRupees(l.principal_repaid),
      outstandingPrincipal: toRupees(l.outstanding_principal),
      interestReceived: toRupees(l.interest_received),
      accruedInterest: toRupees(it.accrued),
      interestPending: toRupees(it.pending),
      asOf: it.asOf,
    };
  }

  // -------------------------------------------------------------------
  // SAFETY CHECK: run after every change to the ledger.
  // Principal can never go below zero on any day, and no entry can be
  // dated before the loan started. If the check fails the whole change
  // is undone (it runs inside a database transaction).
  // -------------------------------------------------------------------
  function assertLedgerOk(loanId, ownerId) {
    const loan = getLoan(loanId, ownerId);
    const rows = db
      .prepare(
        `SELECT type, amount, txn_date FROM transactions
          WHERE loan_id = ? AND is_voided = 0 AND type IN ('disbursement','topup','principal_payment')
          ORDER BY txn_date ASC, CASE type WHEN 'principal_payment' THEN 1 ELSE 0 END, id ASC`
      )
      .all(loanId);
    let balance = 0;
    for (const r of rows) {
      balance += r.type === 'principal_payment' ? -r.amount : r.amount;
      if (balance < 0) {
        throw new HttpError(
          409,
          `This would make the principal balance negative on ${r.txn_date}. Please check the amount and date.`
        );
      }
    }
    const earliest = db
      .prepare('SELECT MIN(txn_date) AS m FROM transactions WHERE loan_id = ? AND is_voided = 0')
      .get(loanId).m;
    if (earliest && earliest < loan.start_date) {
      throw new HttpError(409, `An entry would be dated before the loan start date (${loan.start_date}).`);
    }
  }

  function assertLoanOpen(loan) {
    if (loan.status === 'closed') {
      throw new HttpError(409, 'This loan cycle is closed. Reopen it before changing its payments.');
    }
  }

  // After interest is paid, move the next due date forward while the
  // interest received covers the interest owed up to that due date.
  function advanceDueDate(loanId, ownerId) {
    const loan = getLoan(loanId, ownerId);
    if (!loan.next_due_date || loan.payment_frequency === 'custom') return null;

    const step = (d) =>
      loan.payment_frequency === 'daily' ? addDays(d, 1)
      : loan.payment_frequency === 'weekly' ? addDays(d, 7)
      : addMonths(d, 1);

    let due = loan.next_due_date;
    let moved = false;
    for (let i = 0; i < 60; i++) {
      const it = computeInterest(loan, due, todayStr());
      const covered = it.accrued > 0 && it.received + 100 >= it.accrued;   // Rs 1 tolerance for rounding
      if (!covered) break;
      due = step(due);
      moved = true;
    }
    if (!moved) return null;
    db.prepare('UPDATE loans SET next_due_date = ? WHERE id = ?').run(due, loanId);
    return due;
  }

  // -------------------------------------------------------------------
  // RECORD A PAYMENT / TOP-UP
  // -------------------------------------------------------------------
  app.post('/api/loans/:id/transactions', requireAuth, (req, res) => {
    const loanId = parseId(req.params.id, 'loan ID');
    const body = asObject(req.body);
    const loan = getLoan(loanId, req.user.id);
    if (!loan) throw notFound('Loan');
    assertLoanOpen(loan);

    const type = cleanEnum(body.type, 'Type', ENTRY_TYPES, true);
    const amount = cleanNumber(body.amount, 'Amount', { min: 0.01, max: 1e9, required: true });
    const date = cleanDate(body.date, 'Date') || todayStr();
    if (date > todayStr()) throw bad('Date cannot be in the future.');
    if (date < loan.start_date) throw bad(`Date cannot be before the loan start date (${loan.start_date}).`);

    const method = cleanEnum(body.method, 'Payment method', METHODS) || 'cash';
    const referenceNo = cleanText(body.referenceNo, 'Reference number', 60) ?? null;
    const note = cleanText(body.note, 'Note', 500) ?? null;
    let interestFrom = null;
    let interestTo = null;
    if (type === 'interest_payment') {
      interestFrom = cleanDate(body.interestFrom, 'Interest from') ?? null;
      interestTo = cleanDate(body.interestTo, 'Interest to') ?? null;
      if (interestFrom && interestTo && interestFrom > interestTo) throw bad('"Interest from" must be before "Interest to".');
    }
    const manualDue = cleanDate(body.nextDueDate, 'Next due date');
    const autoAdvance = type === 'interest_payment' && body.advanceDueDate !== false;

    let movedTo = null;
    const txnId = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO transactions (loan_id, type, amount, txn_date, method, reference_no,
                                     interest_from, interest_to, note, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(loanId, type, toPaise(amount), date, method, referenceNo, interestFrom, interestTo, note, req.user.id);
      const id = Number(info.lastInsertRowid);

      assertLedgerOk(loanId, req.user.id);
      audit(req.user.id, 'transactions', id, 'create', null, getTxn(id, req.user.id));

      if (autoAdvance && manualDue === undefined) movedTo = advanceDueDate(loanId, req.user.id);
      if (manualDue !== undefined) {
        const before = getLoan(loanId, req.user.id);
        db.prepare('UPDATE loans SET next_due_date = ? WHERE id = ?').run(manualDue, loanId);
        audit(req.user.id, 'loans', loanId, 'update', before, getLoan(loanId, req.user.id));
      } else if (movedTo) {
        // record the automatic due-date move in the audit log too
        audit(req.user.id, 'loans', loanId, 'update', loan, getLoan(loanId, req.user.id));
      }
      return id;
    })();

    const snap = snapshot(loanId, req.user.id);
    res.status(201).json({
      transaction: txnOut(getTxn(txnId, req.user.id)),
      loan: snap,
      dueDateMovedTo: movedTo,
      principalFullyRepaid: type === 'principal_payment' && snap.outstandingPrincipal === 0,
    });
  });

  app.get('/api/transactions/:id', requireAuth, (req, res) => {
    const t = getTxn(parseId(req.params.id, 'transaction ID'), req.user.id);
    if (!t) throw notFound('Transaction');
    res.json({ transaction: txnOut(t) });
  });

  // -------------------------------------------------------------------
  // EDIT / VOID / RESTORE
  // -------------------------------------------------------------------
  app.patch('/api/transactions/:id', requireAuth, (req, res) => {
    const id = parseId(req.params.id, 'transaction ID');
    const body = asObject(req.body);
    const before = getTxn(id, req.user.id);
    if (!before) throw notFound('Transaction');
    const loan = getLoan(before.loan_id, req.user.id);
    assertLoanOpen(loan);
    if (before.is_voided) throw new HttpError(409, 'This entry is voided. Restore it before editing.');

    const isInitial = before.type === 'disbursement' && initialDisbursementId(before.loan_id) === id;
    const data = {};

    if ('amount' in body) data.amount = toPaise(cleanNumber(body.amount, 'Amount', { min: 0.01, max: 1e9, required: true }));
    if ('date' in body) {
      const d = cleanDate(body.date, 'Date');
      if (!d) throw bad('Date is required.');
      if (d > todayStr()) throw bad('Date cannot be in the future.');
      if (!isInitial && d < loan.start_date) throw bad(`Date cannot be before the loan start date (${loan.start_date}).`);
      data.txn_date = d;
    }
    if ('method' in body) data.method = cleanEnum(body.method, 'Payment method', METHODS, true);
    if ('referenceNo' in body) data.reference_no = cleanText(body.referenceNo, 'Reference number', 60);
    if ('note' in body) data.note = cleanText(body.note, 'Note', 500);
    if (before.type === 'interest_payment') {
      if ('interestFrom' in body) data.interest_from = cleanDate(body.interestFrom, 'Interest from');
      if ('interestTo' in body) data.interest_to = cleanDate(body.interestTo, 'Interest to');
      const from = 'interest_from' in data ? data.interest_from : before.interest_from;
      const to = 'interest_to' in data ? data.interest_to : before.interest_to;
      if (from && to && from > to) throw bad('"Interest from" must be before "Interest to".');
    }

    const changed = Object.keys(data).filter((c) => (before[c] ?? null) !== data[c]);
    if (changed.length) {
      db.transaction(() => {
        const values = { id };
        for (const c of changed) values[c] = data[c];
        db.prepare(`UPDATE transactions SET ${changed.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run(values);

        // The first disbursement defines the loan's start date
        if (isInitial && 'txn_date' in data && data.txn_date !== loan.start_date) {
          db.prepare('UPDATE loans SET start_date = ? WHERE id = ?').run(data.txn_date, before.loan_id);
        }
        assertLedgerOk(before.loan_id, req.user.id);
        audit(req.user.id, 'transactions', id, 'update', before, getTxn(id, req.user.id));
      })();
    }
    res.json({ transaction: txnOut(getTxn(id, req.user.id)), loan: snapshot(before.loan_id, req.user.id) });
  });

  app.post('/api/transactions/:id/void', requireAuth, (req, res) => {
    const id = parseId(req.params.id, 'transaction ID');
    const reason = cleanText(asObject(req.body).reason, 'Reason', 200) ?? null;
    const before = getTxn(id, req.user.id);
    if (!before) throw notFound('Transaction');
    assertLoanOpen(getLoan(before.loan_id, req.user.id));
    if (before.is_voided) return res.json({ transaction: txnOut(before), loan: snapshot(before.loan_id, req.user.id) });
    if (before.type === 'disbursement' && initialDisbursementId(before.loan_id) === id) {
      throw new HttpError(409, 'The first payout of a loan cannot be voided. Edit its amount instead.');
    }
    db.transaction(() => {
      db.prepare('UPDATE transactions SET is_voided = 1, voided_reason = ? WHERE id = ?').run(reason, id);
      assertLedgerOk(before.loan_id, req.user.id);
      audit(req.user.id, 'transactions', id, 'void', before, getTxn(id, req.user.id));
    })();
    res.json({ transaction: txnOut(getTxn(id, req.user.id)), loan: snapshot(before.loan_id, req.user.id) });
  });

  app.post('/api/transactions/:id/restore', requireAuth, (req, res) => {
    const id = parseId(req.params.id, 'transaction ID');
    const before = getTxn(id, req.user.id);
    if (!before) throw notFound('Transaction');
    assertLoanOpen(getLoan(before.loan_id, req.user.id));
    if (!before.is_voided) return res.json({ transaction: txnOut(before), loan: snapshot(before.loan_id, req.user.id) });
    db.transaction(() => {
      db.prepare('UPDATE transactions SET is_voided = 0, voided_reason = NULL WHERE id = ?').run(id);
      assertLedgerOk(before.loan_id, req.user.id);
      audit(req.user.id, 'transactions', id, 'restore', before, getTxn(id, req.user.id));
    })();
    res.json({ transaction: txnOut(getTxn(id, req.user.id)), loan: snapshot(before.loan_id, req.user.id) });
  });

  // -------------------------------------------------------------------
  // INTEREST + STATEMENT
  // -------------------------------------------------------------------
  function defaultAsOf(loan) {
    return loan.status === 'closed' && loan.closed_date ? loan.closed_date : todayStr();
  }

  // ?asOf=YYYY-MM-DD lets you see the position on any date (even a future one)
  app.get('/api/loans/:id/interest', requireAuth, (req, res) => {
    const loan = getLoan(parseId(req.params.id, 'loan ID'), req.user.id);
    if (!loan) throw notFound('Loan');
    const asOf = cleanDate(req.query.asOf || undefined, 'asOf') || defaultAsOf(loan);
    res.json({ interest: interestOut(loan, computeInterest(loan, asOf)) });
  });

  app.get('/api/loans/:id/statement', requireAuth, (req, res) => {
    const loan = getLoan(parseId(req.params.id, 'loan ID'), req.user.id);
    if (!loan) throw notFound('Loan');
    const borrower = db.prepare('SELECT id, full_name, phone FROM borrowers WHERE id = ?').get(loan.borrower_id);

    const rows = db
      .prepare(
        `SELECT * FROM transactions WHERE loan_id = ?
          ORDER BY txn_date ASC, CASE type WHEN 'principal_payment' THEN 1 ELSE 0 END, id ASC`
      )
      .all(loan.id);

    let principal = 0;
    let interestTotal = 0;
    const entries = rows.map((t) => {
      if (!t.is_voided) {
        if (t.type === 'principal_payment') principal -= t.amount;
        else if (t.type === 'interest_payment') interestTotal += t.amount;
        else principal += t.amount;
      }
      return {
        ...txnOut(t),
        principalBalanceAfter: toRupees(principal),
        interestReceivedTotalAfter: toRupees(interestTotal),
      };
    });

    res.json({
      loan: {
        id: loan.id,
        cycleNumber: loan.cycle_number,
        status: loan.status,
        startDate: loan.start_date,
        closedDate: loan.closed_date,
        interestRate: loan.interest_rate,
        ratePeriod: loan.rate_period,
        nextDueDate: loan.next_due_date,
      },
      borrower: { id: borrower.id, fullName: borrower.full_name, phone: borrower.phone },
      interest: interestOut(loan, computeInterest(loan, defaultAsOf(loan))),
      entries,
    });
  });
};
