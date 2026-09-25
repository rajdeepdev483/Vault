// =====================================================================
//  VAULT — Loans screen: every loan cycle across all borrowers, one place
//  to jump into the full loan view (repayments, interest, statement).
// =====================================================================
'use strict';

const Loans = (() => {
  let container = null;
  const S = { status: 'active', items: [] };

  async function render(el) {
    container = el;
    S.status = 'active';
    renderShell();
    await loadList();
  }

  function renderShell() {
    container.innerHTML = `
      <div class="fade-in">
        <div class="greeting" style="margin-bottom:14px;"><h2>Loans</h2></div>
        <div class="filter-row">
          <div class="segmented" id="l-segmented">
            <button data-v="active" class="active">Active</button>
            <button data-v="closed">Closed</button>
            <button data-v="defaulted">Defaulted</button>
            <button data-v="all">All</button>
          </div>
        </div>
        <div id="l-list"></div>
      </div>
    `;
    document.getElementById('l-segmented').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn) return;
      document.querySelectorAll('#l-segmented button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      S.status = btn.dataset.v;
      loadList();
    });
  }

  function rowHtml(l, i) {
    const dueClass = l.nextDueDate && l.nextDueDate < new Date().toISOString().slice(0, 10) && l.status === 'active' ? 'overdue' : '';
    return `
      <div class="borrower-row" data-id="${l.id}" style="animation-delay:${Math.min(i * 30, 240)}ms">
        <div class="avatar">${UI.escapeHtml(UI.initials(l.borrowerName))}</div>
        <div class="info">
          <div class="name-row">
            <span class="name">${UI.escapeHtml(l.borrowerName)}</span>
            <span class="status-pill ${l.status}">${l.status}</span>
          </div>
          <div class="meta">Cycle ${l.cycleNumber} · ${l.interestRate}%/${l.ratePeriod === 'monthly' ? 'mo' : l.ratePeriod === 'yearly' ? 'yr' : 'day'}</div>
        </div>
        <div class="side">
          <div class="amt">${UI.formatMoney(l.outstandingPrincipal, { decimals: 0 })}</div>
          <div class="due ${dueClass}">${l.nextDueDate ? UI.formatDateShort(l.nextDueDate) : (l.closedDate ? 'Closed ' + UI.formatDateShort(l.closedDate) : '—')}</div>
        </div>
        <span class="chev">${UI.icon('chevron-right', { size: 18 })}</span>
      </div>
    `;
  }

  async function loadList() {
    const listEl = document.getElementById('l-list');
    if (!listEl) return;
    listEl.innerHTML = Array.from({ length: 4 }).map(() => '<div class="skel skel-row"></div>').join('');
    let data;
    try {
      data = await Api.get(`/api/loans?status=${S.status}&limit=200`);
    } catch (err) {
      listEl.innerHTML = `<div class="empty-state"><div class="glyph">${UI.icon('alert', { size: 26 })}</div><p>${UI.escapeHtml(err.message)}</p></div>`;
      return;
    }
    S.items = data.loans;
    if (S.items.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="glyph">${UI.icon('list', { size: 26 })}</div>
          <p>No ${S.status === 'all' ? '' : S.status + ' '}loans to show.</p>
        </div>`;
      return;
    }
    listEl.innerHTML = S.items.map(rowHtml).join('');
    listEl.querySelectorAll('.borrower-row').forEach((row) => {
      row.addEventListener('click', () => {
        Loan.open(container, Number(row.dataset.id), () => render(container));
      });
    });
  }

  return { render };
})();