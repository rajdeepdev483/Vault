// =====================================================================
//  VAULT — Loan detail screen: record payments/top-ups, full statement,
//  edit loan settings, close/reopen/mark defaulted
// =====================================================================
'use strict';

const Loan = (() => {
  let container = null;
  let onBack = null;
  let current = null; // last-loaded statement payload

  const TYPE_LABEL = {
    disbursement: 'Loan given', topup: 'Top-up given',
    principal_payment: 'Principal received', interest_payment: 'Interest received',
  };
  const TYPE_DIR = { disbursement: 'out', topup: 'out', principal_payment: 'in', interest_payment: 'in' };

  async function open(el, loanId, backFn) {
    container = el;
    onBack = backFn;
    container.innerHTML = backHeaderHtml('Loan') + `
      <div class="skel" style="height:190px;border-radius:20px;margin-bottom:16px;"></div>
      <div class="skel" style="height:50px;border-radius:14px;margin-bottom:20px;"></div>
      <div class="skel skel-row"></div>
      <div class="skel skel-row"></div>
      <div class="skel skel-row"></div>
    `;
    wireBack();
    await reload(loanId);
  }

  async function reload(loanId) {
    try {
      current = await Api.get(`/api/loans/${loanId}/statement`);
    } catch (err) {
      container.innerHTML = backHeaderHtml('Loan') +
        `<div class="empty-state"><div class="glyph">${UI.icon('alert', { size: 26 })}</div><p>${UI.escapeHtml(err.message)}</p></div>`;
      wireBack();
      return;
    }
    renderScreen();
  }

  function backHeaderHtml(title) {
    return `
      <div class="subview-head">
        <button class="icon-btn" id="ln-back">${UI.icon('chevron-left', { size: 18 })}</button>
        <h2>${title}</h2>
      </div>`;
  }
  function wireBack() {
    const btn = document.getElementById('ln-back');
    if (btn) btn.addEventListener('click', () => onBack && onBack());
  }

  function statusActionsHtml(loan) {
    if (loan.status === 'active') {
      return `
        <button class="btn btn-ghost" id="ln-close">${UI.icon('lock', { size: 15 })} Close cycle</button>
        <button class="btn btn-ghost danger" id="ln-default">${UI.icon('ban', { size: 15 })} Mark defaulted</button>
      `;
    }
    if (loan.status === 'closed' || loan.status === 'defaulted') {
      return `<button class="btn btn-ghost" id="ln-reopen">${UI.icon('unlock', { size: 15 })} Reopen cycle</button>`;
    }
    return '';
  }

  function renderScreen() {
    const { loan, borrower, interest, entries } = current;

    const totalLent = entries.filter((e) => !e.isVoided && (e.type === 'disbursement' || e.type === 'topup'))
      .reduce((s, e) => s + e.amount, 0);

    container.innerHTML = backHeaderHtml(`Cycle ${loan.cycleNumber}`) + `
      <div class="loan-summary-card">
        <div class="loan-summary-top">
          <div>
            <div class="cycle-name">Cycle ${loan.cycleNumber}</div>
            <div class="borrower-link" id="ln-borrower-link">${UI.escapeHtml(borrower.fullName)}${borrower.phone ? ' · ' + UI.escapeHtml(borrower.phone) : ''}</div>
          </div>
          <span class="status-pill ${loan.status}">${loan.status}</span>
        </div>
        <div class="loan-meta-row">
          <div class="lm-item"><div class="lm-label">Started</div><div class="lm-value">${UI.formatDateShort(loan.startDate)}</div></div>
          <div class="lm-item"><div class="lm-label">Rate</div><div class="lm-value">${loan.interestRate}%/${loan.ratePeriod === 'monthly' ? 'mo' : loan.ratePeriod === 'yearly' ? 'yr' : 'day'}</div></div>
          <div class="lm-item"><div class="lm-label">Next due</div><div class="lm-value">${loan.nextDueDate ? UI.formatDateShort(loan.nextDueDate) : '—'}</div></div>
          ${loan.closedDate ? `<div class="lm-item"><div class="lm-label">Closed</div><div class="lm-value">${UI.formatDateShort(loan.closedDate)}</div></div>` : ''}
        </div>
        <div class="loan-action-row">
          <button class="btn btn-ghost" id="ln-edit">${UI.icon('edit', { size: 15 })} Edit settings</button>
          ${statusActionsHtml(loan)}
        </div>
      </div>

      ${interest.outstandingPrincipal === 0 && loan.status === 'active' ? `
        <div class="inline-banner positive inline-banner-row">
          <span>Principal fully repaid.</span>
          <button class="btn btn-primary" id="ln-close-prompt">Close this cycle</button>
        </div>` : ''}

      <div class="stat-grid">
        <div class="stat-card"><div class="label">Outstanding</div><div class="value">${UI.formatMoney(interest.outstandingPrincipal, { decimals: 0 })}</div></div>
        <div class="stat-card"><div class="label">Interest pending</div><div class="value ${interest.interestPending > 0 ? 'warning' : 'positive'}">${UI.formatMoney(Math.abs(interest.interestPending), { decimals: 0 })}</div><div class="sub">${interest.interestPending < 0 ? 'paid in advance' : 'as of ' + UI.formatDateShort(interest.asOf)}</div></div>
        <div class="stat-card"><div class="label">Total lent</div><div class="value">${UI.formatMoney(totalLent, { decimals: 0 })}</div></div>
        <div class="stat-card"><div class="label">Interest received</div><div class="value positive">${UI.formatMoney(interest.interestReceived, { decimals: 0 })}</div></div>
      </div>

      ${loan.status === 'active' ? `
        <button class="record-payment-btn" id="ln-record">${UI.icon('plus', { size: 18 })} Record a payment or top-up</button>
      ` : ''}

      <div class="section">
        <div class="section-head"><h3>Statement</h3><span class="count-pill">${entries.length}</span></div>
        ${entries.length ? [...entries].reverse().map(ledgerRowHtml).join('') : `<div class="empty-state"><div class="glyph">${UI.icon('inbox', { size: 24 })}</div><p>No entries yet.</p></div>`}
      </div>
    `;

    wireBack();
    document.getElementById('ln-borrower-link').addEventListener('click', () => onBack && onBack());
    document.getElementById('ln-edit').addEventListener('click', () => openEditLoanForm(loan));
    const closeBtn = document.getElementById('ln-close');
    if (closeBtn) closeBtn.addEventListener('click', () => doStatusChange(loan, 'closed'));
    const closePromptBtn = document.getElementById('ln-close-prompt');
    if (closePromptBtn) closePromptBtn.addEventListener('click', () => doStatusChange(loan, 'closed'));
    const defaultBtn = document.getElementById('ln-default');
    if (defaultBtn) defaultBtn.addEventListener('click', () => doStatusChange(loan, 'defaulted'));
    const reopenBtn = document.getElementById('ln-reopen');
    if (reopenBtn) reopenBtn.addEventListener('click', () => doStatusChange(loan, 'active'));
    const recordBtn = document.getElementById('ln-record');
    if (recordBtn) recordBtn.addEventListener('click', () => openRecordPaymentForm(loan));

    container.querySelectorAll('[data-txn-row]').forEach((row) => {
      row.addEventListener('click', () => {
        const entry = current.entries.find((e) => e.id === Number(row.dataset.txnRow));
        if (!entry) return;
        // A voided entry has nothing to "edit" — clicking it opens the
        // same menu as the ⋮ button so Restore is still one tap away.
        if (entry.isVoided) { openTxnMenu(entry.id); return; }
        openEditTxnForm(entry);
      });
    });
    container.querySelectorAll('[data-txn-menu]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation(); // don't also trigger the row's own click-to-edit
        openTxnMenu(Number(btn.dataset.txnMenu));
      });
    });
  }

  function ledgerRowHtml(e) {
    const dir = TYPE_DIR[e.type];
    const canManage = e.type !== 'disbursement' || false; // menu still offered; edit-only enforced server-side for the first payout
    return `
      <div class="ledger-row ${e.isVoided ? 'voided' : ''}" data-txn-row="${e.id}">
        <div class="activity-icon ${dir}">${UI.icon(dir === 'out' ? 'arrow-up-right' : 'arrow-down-left', { size: 16 })}</div>
        <div class="info">
          <div class="type-label">${TYPE_LABEL[e.type]}${e.isVoided ? '<span class="voided-tag">Voided</span>' : ''}</div>
          <div class="sub">${UI.formatDateShort(e.date)} · ${e.method.replace('_', ' ')}${e.referenceNo ? ' · ' + UI.escapeHtml(e.referenceNo) : ''}</div>
        </div>
        <div class="amt-col">
          <div class="amt ${dir}">${dir === 'in' ? '+' : ''}${UI.formatMoney(e.amount, { decimals: 0 })}</div>
          <div class="bal">bal ${UI.formatMoney(e.principalBalanceAfter, { decimals: 0, withSymbol: false })}</div>
        </div>
        <button class="row-menu-btn" data-txn-menu="${e.id}">${UI.icon('more-vertical', { size: 16 })}</button>
      </div>
    `;
  }

  // -------------------------------------------------------------------
  // RECORD PAYMENT / TOP-UP
  // -------------------------------------------------------------------
  function openRecordPaymentForm(loan) {
    const today = new Date().toISOString().slice(0, 10);
    let type = 'principal_payment';

    const { bodyEl, footEl, close } = Modal.open({
      title: 'Record a payment',
      bodyHtml: `
        <div class="type-tabs" id="rp-tabs">
          <button data-t="principal_payment" class="active">Repayment</button>
          <button data-t="interest_payment">Interest</button>
          <button data-t="topup">Top-up</button>
        </div>
        <form id="rp-form">
          <div class="form-grid cols-2">
            <div class="field">
              <label>Amount *</label>
              <input name="amount" type="number" step="0.01" min="0.01" required placeholder="e.g. 1000">
            </div>
            <div class="field">
              <label>Date</label>
              <input name="date" type="date" value="${today}" max="${today}" min="${loan.startDate}">
            </div>
            <div class="field">
              <label>Method</label>
              <select name="method">
                <option value="cash" selected>Cash</option>
                <option value="upi">UPI</option>
                <option value="bank_transfer">Bank transfer</option>
                <option value="cheque">Cheque</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div class="field">
              <label>Reference no. (optional)</label>
              <input name="referenceNo" type="text" maxlength="60">
            </div>
            <div class="field interest-only" style="display:none;">
              <label>Interest from (optional)</label>
              <input name="interestFrom" type="date" max="${today}">
            </div>
            <div class="field interest-only" style="display:none;">
              <label>Interest to (optional)</label>
              <input name="interestTo" type="date" max="${today}">
            </div>
            <div class="field interest-only" style="display:none;grid-column:1 / -1;">
              <label>Set next due date (optional — leave blank to move automatically)</label>
              <input name="nextDueDate" type="date">
            </div>
            <div class="field" style="grid-column:1 / -1;">
              <label>Note (optional)</label>
              <textarea name="note" maxlength="500"></textarea>
            </div>
          </div>
        </form>
      `,
      footHtml: `
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="submit" form="rp-form" class="btn btn-primary" id="rp-save">Save entry</button>
      `,
      onMount: (body, foot, closeFn) => {
        foot.querySelector('[data-cancel]').addEventListener('click', closeFn);
        const tabs = body.querySelector('#rp-tabs');
        tabs.addEventListener('click', (e) => {
          const btn = e.target.closest('button[data-t]');
          if (!btn) return;
          type = btn.dataset.t;
          tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
          body.querySelectorAll('.interest-only').forEach((f) => { f.style.display = type === 'interest_payment' ? 'block' : 'none'; });
        });
        const form = body.querySelector('#rp-form');
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('rp-save');
          const amount = form.amount.value;
          if (!amount || Number(amount) <= 0) { UI.toast('Enter a valid amount'); return; }
          const payload = {
            type,
            amount: Number(amount),
            date: form.date.value || today,
            method: form.method.value,
          };
          if (form.referenceNo.value.trim()) payload.referenceNo = form.referenceNo.value.trim();
          if (form.note.value.trim()) payload.note = form.note.value.trim();
          if (type === 'interest_payment') {
            if (form.interestFrom.value) payload.interestFrom = form.interestFrom.value;
            if (form.interestTo.value) payload.interestTo = form.interestTo.value;
            if (form.nextDueDate.value) payload.nextDueDate = form.nextDueDate.value;
          }
          btn.disabled = true;
          btn.textContent = 'Saving…';
          try {
            const result = await Api.post(`/api/loans/${loan.id}/transactions`, payload);
            closeFn();
            let msg = 'Entry recorded';
            if (result.dueDateMovedTo) msg += ` · next due ${UI.formatDateShort(result.dueDateMovedTo)}`;
            UI.toast(msg);
            await reload(loan.id);
            UI.pulse(container.querySelector('.loan-summary-card'));
          } catch (err) {
            UI.toast(err.message);
            btn.disabled = false;
            btn.textContent = 'Save entry';
          }
        });
      },
    });
    void bodyEl; void footEl; void close;
  }

  // -------------------------------------------------------------------
  // EDIT LOAN SETTINGS
  // -------------------------------------------------------------------
  function openEditLoanForm(loan) {
    Modal.open({
      title: 'Edit loan settings',
      bodyHtml: `
        <form id="le-form">
          <div class="form-grid cols-2">
            <div class="field">
              <label>Interest rate (%)</label>
              <input name="interestRate" type="number" step="0.01" min="0" value="${loan.interestRate}">
            </div>
            <div class="field">
              <label>Rate period</label>
              <select name="ratePeriod">
                <option value="monthly" ${loan.ratePeriod === 'monthly' ? 'selected' : ''}>Per month</option>
                <option value="daily" ${loan.ratePeriod === 'daily' ? 'selected' : ''}>Per day</option>
                <option value="yearly" ${loan.ratePeriod === 'yearly' ? 'selected' : ''}>Per year</option>
              </select>
            </div>
            <div class="field">
              <label>Payment frequency</label>
              <select name="paymentFrequency">
                <option value="monthly" ${loan.paymentFrequency === 'monthly' ? 'selected' : ''}>Monthly</option>
                <option value="weekly" ${loan.paymentFrequency === 'weekly' ? 'selected' : ''}>Weekly</option>
                <option value="daily" ${loan.paymentFrequency === 'daily' ? 'selected' : ''}>Daily</option>
                <option value="custom" ${loan.paymentFrequency === 'custom' ? 'selected' : ''}>Custom</option>
              </select>
            </div>
            <div class="field">
              <label>Next due date</label>
              <input name="nextDueDate" type="date" value="${loan.nextDueDate || ''}">
            </div>
            <div class="field">
              <label>Expected payment (optional)</label>
              <input name="expectedAmount" type="number" step="0.01" min="0.01" value="${loan.expectedAmount ?? ''}">
            </div>
            <div class="field" style="grid-column:1 / -1;">
              <label>Notes</label>
              <textarea name="notes" maxlength="2000">${UI.escapeHtml(loan.notes || '')}</textarea>
            </div>
          </div>
        </form>
      `,
      footHtml: `
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="submit" form="le-form" class="btn btn-primary" id="le-save">Save changes</button>
      `,
      onMount: (body, foot, closeFn) => {
        foot.querySelector('[data-cancel]').addEventListener('click', closeFn);
        const form = body.querySelector('#le-form');
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('le-save');
          const payload = {
            interestRate: Number(form.interestRate.value),
            ratePeriod: form.ratePeriod.value,
            paymentFrequency: form.paymentFrequency.value,
            nextDueDate: form.nextDueDate.value || null,
            notes: form.notes.value.trim(),
          };
          payload.expectedAmount = form.expectedAmount.value ? Number(form.expectedAmount.value) : null;
          btn.disabled = true;
          btn.textContent = 'Saving…';
          try {
            await Api.patch(`/api/loans/${loan.id}`, payload);
            closeFn();
            UI.toast('Loan settings updated');
            await reload(loan.id);
            UI.pulse(container.querySelector('.loan-summary-card'));
          } catch (err) {
            UI.toast(err.message);
            btn.disabled = false;
            btn.textContent = 'Save changes';
          }
        });
      },
    });
  }

  // -------------------------------------------------------------------
  // STATUS CHANGE (close / reopen / mark defaulted)
  // -------------------------------------------------------------------
  async function doStatusChange(loan, status, force) {
    const copy = {
      closed: { title: 'Close this cycle', message: 'Close this loan cycle? You can reopen it later if needed.', label: 'Close cycle' },
      defaulted: { title: 'Mark as defaulted', message: 'Mark this loan cycle as defaulted? This flags it separately on the dashboard — it does not delete any history.', label: 'Mark defaulted', danger: true },
      active: { title: 'Reopen this cycle', message: 'Reopen this loan cycle so payments can be recorded again?', label: 'Reopen' },
    }[status];

    const ok = await Modal.confirm({ title: copy.title, message: copy.message, confirmLabel: copy.label, danger: copy.danger });
    if (!ok) return;

    try {
      const payload = { status };
      if (force) payload.force = true;
      await Api.post(`/api/loans/${loan.id}/status`, payload);
      UI.toast(status === 'closed' ? 'Cycle closed' : status === 'active' ? 'Cycle reopened' : 'Marked defaulted');
      await reload(loan.id);
      UI.pulse(container.querySelector('.loan-summary-card'));
    } catch (err) {
      if (err.status === 409 && err.extra && err.extra.needsConfirmation) {
        const forceOk = await Modal.confirm({
          title: 'Principal still outstanding',
          message: `${UI.formatMoney(err.extra.outstandingPrincipal, { decimals: 0 })} is still outstanding on this loan. Close it anyway?`,
          confirmLabel: 'Close anyway',
          danger: true,
        });
        if (forceOk) return doStatusChange(loan, status, true);
        return;
      }
      UI.toast(err.message);
    }
  }

  // -------------------------------------------------------------------
  // PER-ENTRY MENU (edit / void / restore)
  // -------------------------------------------------------------------
  function openTxnMenu(txnId) {
    const entry = current.entries.find((e) => e.id === txnId);
    if (!entry) return;
    const isFirstPayout = entry.type === 'disbursement' && current.entries.filter((e) => e.type === 'disbursement').every((d) => d.id >= entry.id);

    const items = [];
    items.push({ key: 'edit', icon: 'edit', label: 'Edit entry' });
    if (entry.isVoided) {
      items.push({ key: 'restore', icon: 'undo', label: 'Restore entry' });
    } else if (!(entry.type === 'disbursement' && isFirstPayout)) {
      items.push({ key: 'void', icon: 'ban', label: 'Void entry', danger: true });
    }

    Modal.open({
      title: TYPE_LABEL[entry.type],
      bodyHtml: `<div class="action-sheet-list">${items.map((it) => `
        <div class="action-sheet-item ${it.danger ? 'danger' : ''}" data-act="${it.key}">
          ${UI.icon(it.icon, { size: 17 })}<span>${it.label}</span>
        </div>`).join('')}</div>`,
      onMount: (body, foot, closeFn) => {
        body.querySelectorAll('[data-act]').forEach((el) => {
          el.addEventListener('click', () => {
            const act = el.dataset.act;
            closeFn();
            if (act === 'edit') openEditTxnForm(entry);
            if (act === 'void') openVoidForm(entry);
            if (act === 'restore') doRestore(entry);
          });
        });
      },
    });
  }

  function openEditTxnForm(entry) {
    const isInterest = entry.type === 'interest_payment';
    Modal.open({
      title: `Edit — ${TYPE_LABEL[entry.type]}`,
      bodyHtml: `
        <form id="te-form">
          <div class="form-grid cols-2">
            <div class="field">
              <label>Amount *</label>
              <input name="amount" type="number" step="0.01" min="0.01" required value="${entry.amount}">
            </div>
            <div class="field">
              <label>Date</label>
              <input name="date" type="date" value="${entry.date}" max="${new Date().toISOString().slice(0, 10)}">
            </div>
            <div class="field">
              <label>Method</label>
              <select name="method">
                ${['cash', 'upi', 'bank_transfer', 'cheque', 'other'].map((m) => `<option value="${m}" ${entry.method === m ? 'selected' : ''}>${m.replace('_', ' ')}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>Reference no.</label>
              <input name="referenceNo" type="text" maxlength="60" value="${UI.escapeHtml(entry.referenceNo || '')}">
            </div>
            ${isInterest ? `
            <div class="field">
              <label>Interest from</label>
              <input name="interestFrom" type="date" value="${entry.interestFrom || ''}">
            </div>
            <div class="field">
              <label>Interest to</label>
              <input name="interestTo" type="date" value="${entry.interestTo || ''}">
            </div>` : ''}
            <div class="field" style="grid-column:1 / -1;">
              <label>Note</label>
              <textarea name="note" maxlength="500">${UI.escapeHtml(entry.note || '')}</textarea>
            </div>
          </div>
        </form>
      `,
      footHtml: `
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="submit" form="te-form" class="btn btn-primary" id="te-save">Save</button>
      `,
      onMount: (body, foot, closeFn) => {
        foot.querySelector('[data-cancel]').addEventListener('click', closeFn);
        const form = body.querySelector('#te-form');
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('te-save');
          const payload = {
            amount: Number(form.amount.value),
            date: form.date.value,
            method: form.method.value,
            referenceNo: form.referenceNo.value.trim(),
            note: form.note.value.trim(),
          };
          if (isInterest) {
            payload.interestFrom = form.interestFrom.value || null;
            payload.interestTo = form.interestTo.value || null;
          }
          btn.disabled = true;
          btn.textContent = 'Saving…';
          try {
            await Api.patch(`/api/transactions/${entry.id}`, payload);
            closeFn();
            UI.toast('Entry updated');
            await reload(entry.loanId);
            UI.pulse(container.querySelector('.loan-summary-card'));
          } catch (err) {
            UI.toast(err.message);
            btn.disabled = false;
            btn.textContent = 'Save';
          }
        });
      },
    });
  }

  function openVoidForm(entry) {
    Modal.open({
      title: 'Void this entry',
      bodyHtml: `
        <p style="color:var(--text-muted);font-size:13.5px;margin-bottom:12px;">The entry is kept for the record but no longer counts toward the balance. You can restore it later.</p>
        <div class="field">
          <label>Reason (optional)</label>
          <textarea id="void-reason" maxlength="200" placeholder="e.g. entered by mistake"></textarea>
        </div>
      `,
      footHtml: `
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="button" class="btn btn-primary" id="void-confirm" style="background:var(--warning);color:#fff;box-shadow:none;">Void entry</button>
      `,
      onMount: (body, foot, closeFn) => {
        foot.querySelector('[data-cancel]').addEventListener('click', closeFn);
        foot.querySelector('#void-confirm').addEventListener('click', async () => {
          const btn = foot.querySelector('#void-confirm');
          btn.disabled = true;
          try {
            const reason = body.querySelector('#void-reason').value.trim();
            await Api.post(`/api/transactions/${entry.id}/void`, reason ? { reason } : {});
            closeFn();
            UI.toast('Entry voided');
            await reload(entry.loanId);
            UI.pulse(container.querySelector('.loan-summary-card'));
          } catch (err) {
            UI.toast(err.message);
            btn.disabled = false;
          }
        });
      },
    });
  }

  async function doRestore(entry) {
    try {
      await Api.post(`/api/transactions/${entry.id}/restore`);
      UI.toast('Entry restored');
      await reload(entry.loanId);
      UI.pulse(container.querySelector('.loan-summary-card'));
    } catch (err) {
      UI.toast(err.message);
    }
  }

  return { open };
})();