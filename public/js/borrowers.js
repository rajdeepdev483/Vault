// =====================================================================
//  VAULT — Borrowers: list + search/filter, add/edit form,
//  profile with loan cycles, start a new loan cycle
// =====================================================================
'use strict';

const Borrowers = (() => {
  let container = null;
  let settingsCache = null;

  const state = () => ({
    archived: '0',
    search: '',
    sort: 'name',
    offset: 0,
    limit: 20,
    total: 0,
    items: [],
  });
  let S = state();
  let searchDebounce = null;

  // -------------------------------------------------------------------
  // FORM FIELD DEFINITIONS (mirrors BORROWER_FIELDS in routes/borrowers-loans.js)
  // -------------------------------------------------------------------
  const FORM_SECTIONS = [
    {
      title: 'Personal',
      fields: [
        { name: 'fullName', label: 'Full name', required: true, max: 100 },
        { name: 'fatherOrSpouse', label: "Father's / spouse name", max: 100 },
        { name: 'phone', label: 'Phone', type: 'tel', max: 20 },
        { name: 'altPhone', label: 'Alternate phone', type: 'tel', max: 20 },
        { name: 'email', label: 'Email', type: 'email', max: 120 },
        { name: 'occupation', label: 'Occupation', max: 100 },
      ],
    },
    {
      title: 'Address',
      fields: [
        { name: 'city', label: 'City', max: 80 },
        { name: 'address', label: 'Address', max: 500, full: true, textarea: true },
      ],
    },
    {
      title: 'ID & Guarantor',
      fields: [
        { name: 'idProofType', label: 'ID proof type', max: 40, placeholder: 'Aadhaar, PAN, Voter ID…' },
        { name: 'idProofNumber', label: 'ID proof number', max: 40 },
        { name: 'guarantorName', label: 'Guarantor name', max: 100 },
        { name: 'guarantorPhone', label: 'Guarantor phone', type: 'tel', max: 20 },
        { name: 'guarantorAddress', label: 'Guarantor address', max: 500, full: true, textarea: true },
        { name: 'collateralDetails', label: 'Collateral details', max: 1000, full: true, textarea: true, placeholder: 'Gold, land papers, cheque…' },
      ],
    },
    {
      title: 'Notes',
      fields: [
        { name: 'notes', label: 'Notes', max: 2000, full: true, textarea: true },
      ],
    },
  ];
  const ALL_FIELD_NAMES = FORM_SECTIONS.flatMap((s) => s.fields.map((f) => f.name));
  const FIELD_META = {};
  FORM_SECTIONS.forEach((s) => s.fields.forEach((f) => { FIELD_META[f.name] = f; }));
  // Fields shown in the profile header, not repeated in the detail grid.
  const HEADER_FIELD_NAMES = new Set(['fullName', 'phone', 'city']);

  function fieldHtml(f, value) {
    const v = UI.escapeHtml(value || '');
    if (f.textarea) {
      return `
        <div class="field" style="grid-column:${f.full ? '1 / -1' : 'auto'};">
          <label>${f.label}${f.required ? ' *' : ''}</label>
          <textarea name="${f.name}" maxlength="${f.max}" placeholder="${f.placeholder || ''}">${v}</textarea>
        </div>`;
    }
    return `
      <div class="field" style="grid-column:${f.full ? '1 / -1' : 'auto'};">
        <label>${f.label}${f.required ? ' *' : ''}</label>
        <input name="${f.name}" type="${f.type || 'text'}" maxlength="${f.max}" placeholder="${f.placeholder || ''}" value="${v}" ${f.required ? 'required' : ''}>
      </div>`;
  }

  function formBodyHtml(values = {}) {
    return FORM_SECTIONS.map((section) => `
      <div class="form-section-title">${section.title}</div>
      <div class="form-grid cols-2">
        ${section.fields.map((f) => fieldHtml(f, values[f.name])).join('')}
      </div>
    `).join('');
  }

  function collectFields(bodyEl) {
    const out = {};
    for (const name of ALL_FIELD_NAMES) {
      const el = bodyEl.querySelector(`[name="${name}"]`);
      if (el) out[name] = el.value.trim();
    }
    return out;
  }

  // -------------------------------------------------------------------
  // LIST SCREEN
  // -------------------------------------------------------------------
  async function render(el) {
    container = el;
    S = state();
    renderShell();
    await loadList(true);
  }

  function renderShell() {
    container.innerHTML = `
      <div class="fade-in">
        <div class="greeting" style="margin-bottom:14px;">
          <h2>Borrowers</h2>
        </div>
        <div class="search-bar" id="b-search-bar">
          ${UI.icon('search', { size: 16 })}
          <input id="b-search" type="text" placeholder="Search by name, phone or city" autocomplete="off">
          <span class="clear-btn" id="b-search-clear">${UI.icon('x', { size: 15 })}</span>
        </div>
        <div class="filter-row">
          <div class="segmented" id="b-segmented">
            <button data-v="0" class="active">Active</button>
            <button data-v="1">Archived</button>
            <button data-v="all">All</button>
          </div>
          <select class="sort-select" id="b-sort">
            <option value="name">Name A–Z</option>
            <option value="recent">Recently added</option>
            <option value="due">Due date</option>
          </select>
        </div>
        <div id="b-list"></div>
      </div>
      <button class="fab" id="b-fab" aria-label="Add borrower" title="Add borrower">${UI.icon('plus', { size: 24 })}</button>
    `;

    const searchInput = document.getElementById('b-search');
    searchInput.addEventListener('input', () => {
      document.getElementById('b-search-bar').classList.toggle('has-text', !!searchInput.value);
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        S.search = searchInput.value.trim();
        loadList(true);
      }, 300);
    });
    document.getElementById('b-search-clear').addEventListener('click', () => {
      searchInput.value = '';
      document.getElementById('b-search-bar').classList.remove('has-text');
      S.search = '';
      loadList(true);
    });
    document.getElementById('b-segmented').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn) return;
      document.querySelectorAll('#b-segmented button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      S.archived = btn.dataset.v;
      loadList(true);
    });
    document.getElementById('b-sort').addEventListener('change', (e) => {
      S.sort = e.target.value;
      loadList(true);
    });
    document.getElementById('b-fab').addEventListener('click', openAddForm);
  }

  function borrowerRowHtml(b, i) {
    const dueClass = b.nextDueDate && b.nextDueDate < new Date().toISOString().slice(0, 10) ? 'overdue' : '';
    return `
      <div class="borrower-row ${b.isArchived ? 'archived' : ''}" data-id="${b.id}" style="animation-delay:${Math.min(i * 30, 240)}ms">
        <div class="avatar">${UI.escapeHtml(UI.initials(b.fullName))}</div>
        <div class="info">
          <div class="name-row">
            <span class="name">${UI.escapeHtml(b.fullName)}</span>
            ${b.isArchived ? '<span class="tag-pill archived-pill">Archived</span>' : ''}
          </div>
          <div class="meta">${[b.phone, b.city].filter(Boolean).join(' · ') || 'No contact details'}</div>
        </div>
        <div class="side">
          ${b.outstandingPrincipal ? `<div class="amt">${UI.formatMoney(b.outstandingPrincipal, { decimals: 0 })}</div>` : '<div class="amt" style="color:var(--text-faint);">—</div>'}
          <div class="due ${dueClass}">${b.nextDueDate ? UI.formatDateShort(b.nextDueDate) : 'No active loan'}</div>
        </div>
        <span class="chev">${UI.icon('chevron-right', { size: 18 })}</span>
      </div>
    `;
  }

  async function loadList(reset) {
    const listEl = document.getElementById('b-list');
    if (!listEl) return;
    if (reset) {
      S.offset = 0;
      listEl.innerHTML = Array.from({ length: 4 }).map(() => '<div class="skel skel-row"></div>').join('');
    }
    let data;
    try {
      const qs = new URLSearchParams({
        archived: S.archived, sort: S.sort, limit: S.limit, offset: S.offset,
      });
      if (S.search) qs.set('search', S.search);
      data = await Api.get(`/api/borrowers?${qs.toString()}`);
    } catch (err) {
      listEl.innerHTML = `<div class="empty-state"><div class="glyph">${UI.icon('alert', { size: 26 })}</div><p>${UI.escapeHtml(err.message)}</p></div>`;
      return;
    }
    S.total = data.total;
    S.items = reset ? data.borrowers : S.items.concat(data.borrowers);

    if (S.items.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="glyph">${UI.icon('users', { size: 26 })}</div>
          <p>${S.search ? 'No borrowers match your search.' : 'No borrowers yet. Tap + to add your first one.'}</p>
        </div>`;
      return;
    }

    listEl.innerHTML = S.items.map(borrowerRowHtml).join('') +
      (S.items.length < S.total
        ? `<div class="load-more-row"><button class="btn btn-ghost" id="b-load-more" style="width:auto;padding:9px 18px;">Load more (${S.total - S.items.length} left)</button></div>`
        : '');

    listEl.querySelectorAll('.borrower-row').forEach((row) => {
      row.addEventListener('click', () => openProfile(Number(row.dataset.id)));
    });
    const loadMoreBtn = document.getElementById('b-load-more');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => {
        S.offset += S.limit;
        loadList(false);
      });
    }
  }

  // -------------------------------------------------------------------
  // ADD / EDIT FORM
  // -------------------------------------------------------------------
  function openAddForm() {
    Modal.open({
      title: 'Add borrower',
      bodyHtml: `<form id="b-form">${formBodyHtml()}</form>`,
      footHtml: `
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="submit" form="b-form" class="btn btn-primary" id="b-save">Save borrower</button>
      `,
      onMount: (body, foot, close) => {
        foot.querySelector('[data-cancel]').addEventListener('click', close);
        const form = body.querySelector('#b-form');
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('b-save');
          const fields = collectFields(body);
          if (!fields.fullName) { UI.toast('Full name is required'); return; }
          btn.disabled = true;
          btn.textContent = 'Saving…';
          try {
            const { borrower } = await Api.post('/api/borrowers', fields);
            close();
            UI.toast('Borrower added');
            await loadList(true);
            openProfile(borrower.id);
          } catch (err) {
            UI.toast(err.message);
            btn.disabled = false;
            btn.textContent = 'Save borrower';
          }
        });
      },
    });
  }

  function openEditForm(borrower, onSaved) {
    Modal.open({
      title: 'Edit borrower',
      bodyHtml: `<form id="b-form">${formBodyHtml(borrower)}</form>`,
      footHtml: `
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="submit" form="b-form" class="btn btn-primary" id="b-save">Save changes</button>
      `,
      onMount: (body, foot, close) => {
        foot.querySelector('[data-cancel]').addEventListener('click', close);
        const form = body.querySelector('#b-form');
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('b-save');
          const fields = collectFields(body);
          if (!fields.fullName) { UI.toast('Full name is required'); return; }
          btn.disabled = true;
          btn.textContent = 'Saving…';
          try {
            await Api.patch(`/api/borrowers/${borrower.id}`, fields);
            close();
            UI.toast('Changes saved');
            if (onSaved) onSaved();
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
  // PROFILE SCREEN
  // -------------------------------------------------------------------
  async function openProfile(id) {
    container.innerHTML = `
      <div class="subview-head">
        <button class="icon-btn" id="b-back">${UI.icon('chevron-left', { size: 18 })}</button>
        <h2>Borrower</h2>
      </div>
      <div class="skel" style="height:180px;border-radius:20px;margin-bottom:20px;"></div>
      <div class="skel skel-row"></div>
      <div class="skel skel-row"></div>
    `;
    document.getElementById('b-back').addEventListener('click', () => render(container));

    let borrower;
    try {
      const data = await Api.get(`/api/borrowers/${id}`);
      borrower = data.borrower;
    } catch (err) {
      container.innerHTML = `
        <div class="subview-head">
          <button class="icon-btn" id="b-back">${UI.icon('chevron-left', { size: 18 })}</button>
          <h2>Borrower</h2>
        </div>
        <div class="empty-state"><div class="glyph">${UI.icon('alert', { size: 26 })}</div><p>${UI.escapeHtml(err.message)}</p></div>
      `;
      document.getElementById('b-back').addEventListener('click', () => render(container));
      return;
    }

    renderProfile(borrower);
  }

  function renderProfile(borrower) {
    const hasActive = borrower.loans.some((l) => l.status === 'active');
    // Every field except the three shown in the header — driven from the
    // same FORM_SECTIONS metadata the Add-borrower modal uses, so labels/
    // limits/placeholders stay in one place.
    const detailFields = ALL_FIELD_NAMES.filter((n) => !HEADER_FIELD_NAMES.has(n));

    container.innerHTML = `
      <div class="subview-head">
        <button class="icon-btn" id="b-back">${UI.icon('chevron-left', { size: 18 })}</button>
        <h2>Borrower profile</h2>
      </div>

      <div class="profile-card">
        <div class="profile-top">
          <div class="avatar" id="b-avatar">${UI.escapeHtml(UI.initials(borrower.fullName))}</div>
          <div style="min-width:0;flex:1;">
            <div class="name" id="b-name-field"></div>
            <div class="sub" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <span id="b-phone-field"></span>
              <span style="color:var(--text-faint);">·</span>
              <span id="b-city-field"></span>
              ${borrower.isArchived ? '<span class="tag-pill archived-pill">Archived</span>' : ''}
            </div>
          </div>
        </div>
        <div class="profile-actions">
          <span id="b-call-wrap"></span>
          <button class="btn btn-ghost" id="b-edit">${UI.icon('edit', { size: 15 })} Edit all</button>
          ${borrower.isArchived
            ? `<button class="btn btn-ghost" id="b-restore">${UI.icon('undo', { size: 15 })} Restore</button>`
            : hasActive ? '' : `<button class="btn btn-ghost" id="b-archive">${UI.icon('archive', { size: 15 })} Archive</button>`}
        </div>
        <div class="profile-totals">
          <div>
            <div class="t-label">Outstanding</div>
            <div class="t-value">${UI.formatMoney(borrower.totals.outstandingPrincipal, { decimals: 0 })}</div>
          </div>
          <div>
            <div class="t-label">Interest received</div>
            <div class="t-value" style="color:var(--positive);">${UI.formatMoney(borrower.totals.interestReceived, { decimals: 0 })}</div>
          </div>
          <div>
            <div class="t-label">Loan cycles</div>
            <div class="t-value">${borrower.totals.totalCycles}</div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h3>Details</h3><span style="font-size:11.5px;color:var(--text-faint);">Tap any field to edit</span></div>
        <div class="profile-card">
          <div class="detail-grid">
            ${detailFields.map((name) => `
              <div class="d-item">
                <div class="d-label">${FIELD_META[name].label}</div>
                <div class="d-value" id="b-field-${name}"></div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <h3>Loan cycles</h3>
          ${!hasActive && !borrower.isArchived ? `<button class="btn btn-primary" id="b-new-loan" style="width:auto;padding:8px 14px;font-size:13px;">${UI.icon('plus', { size: 14 })} New loan</button>` : ''}
        </div>
        ${borrower.loans.length ? borrower.loans.map(cycleCardHtml).join('') : `<div class="empty-state"><div class="glyph">${UI.icon('list', { size: 24 })}</div><p>No loan cycles yet.</p></div>`}
      </div>
    `;

    document.getElementById('b-back').addEventListener('click', () => render(container));

    // ---- click-to-edit wiring: every field saves straight to the same
    //      PATCH endpoint the old "Edit" modal used, one field at a time ----
    const patch = (fields) => Api.patch(`/api/borrowers/${borrower.id}`, fields);

    function renderCallButton() {
      const wrap = document.getElementById('b-call-wrap');
      wrap.innerHTML = borrower.phone
        ? `<button class="btn btn-ghost" id="b-call">${UI.icon('phone', { size: 15 })} Call</button>` : '';
      const btn = document.getElementById('b-call');
      if (btn) btn.addEventListener('click', () => { window.location.href = `tel:${borrower.phone}`; });
    }
    renderCallButton();

    UI.editableField(document.getElementById('b-name-field'), {
      value: borrower.fullName,
      required: true,
      label: 'Full name',
      maxLength: FIELD_META.fullName.max,
      block: true,
      onSave: async (v) => {
        await patch({ fullName: v });
        borrower.fullName = v;
        document.getElementById('b-avatar').textContent = UI.initials(v);
      },
    });
    UI.editableField(document.getElementById('b-phone-field'), {
      value: borrower.phone,
      emptyText: 'Add phone',
      maxLength: 20,
      onSave: async (v) => { await patch({ phone: v }); borrower.phone = v; renderCallButton(); },
    });
    UI.editableField(document.getElementById('b-city-field'), {
      value: borrower.city,
      emptyText: 'Add city',
      maxLength: 80,
      onSave: async (v) => { await patch({ city: v }); borrower.city = v; },
    });
    detailFields.forEach((name) => {
      const meta = FIELD_META[name];
      UI.editableField(document.getElementById(`b-field-${name}`), {
        value: borrower[name],
        type: meta.textarea ? 'textarea' : 'text',
        placeholder: meta.placeholder,
        maxLength: meta.max,
        label: meta.label,
        block: true,
        onSave: async (v) => { await patch({ [name]: v }); borrower[name] = v; },
      });
    });

    document.getElementById('b-edit').addEventListener('click', () => {
      openEditForm(borrower, () => openProfile(borrower.id));
    });
    const archiveBtn = document.getElementById('b-archive');
    if (archiveBtn) {
      archiveBtn.addEventListener('click', async () => {
        const ok = await Modal.confirm({
          title: 'Archive borrower',
          message: `Archive ${UI.escapeHtml(borrower.fullName)}? They will be hidden from the active list. This has no effect on their loan history.`,
          confirmLabel: 'Archive',
        });
        if (!ok) return;
        try {
          await Api.post(`/api/borrowers/${borrower.id}/archive`);
          UI.toast('Borrower archived');
          openProfile(borrower.id);
        } catch (err) { UI.toast(err.message); }
      });
    }
    const restoreBtn = document.getElementById('b-restore');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', async () => {
        try {
          await Api.post(`/api/borrowers/${borrower.id}/restore`);
          UI.toast('Borrower restored');
          openProfile(borrower.id);
        } catch (err) { UI.toast(err.message); }
      });
    }
    const newLoanBtn = document.getElementById('b-new-loan');
    if (newLoanBtn) newLoanBtn.addEventListener('click', () => openNewLoanForm(borrower));

    container.querySelectorAll('.cycle-card').forEach((el) => {
      el.addEventListener('click', () => {
        Loan.open(container, Number(el.dataset.id), () => openProfile(borrower.id));
      });
    });
  }

  function cycleCardHtml(l) {
    return `
      <div class="cycle-card" data-id="${l.id}">
        <div class="row1">
          <span class="cycle-title">Cycle ${l.cycleNumber} · ${UI.formatDateShort(l.startDate)}</span>
          <span class="status-pill ${l.status}">${l.status}</span>
        </div>
        <div class="cycle-stats">
          <div>
            <div class="cs-label">Outstanding</div>
            <div class="cs-value">${UI.formatMoney(l.outstandingPrincipal, { decimals: 0 })}</div>
          </div>
          <div>
            <div class="cs-label">Rate</div>
            <div class="cs-value">${l.interestRate}%/${l.ratePeriod === 'monthly' ? 'mo' : l.ratePeriod === 'yearly' ? 'yr' : 'day'}</div>
          </div>
          ${l.status === 'active' ? `
          <div>
            <div class="cs-label">Next due</div>
            <div class="cs-value">${l.nextDueDate ? UI.formatDateShort(l.nextDueDate) : '—'}</div>
          </div>` : ''}
        </div>
      </div>
    `;
  }

  // -------------------------------------------------------------------
  // START A NEW LOAN CYCLE
  // -------------------------------------------------------------------
  async function openNewLoanForm(borrower) {
    if (!settingsCache) {
      try { settingsCache = (await Api.get('/api/settings')).settings; } catch (e) { settingsCache = {}; }
    }
    const today = new Date().toISOString().slice(0, 10);
    const defaultRate = settingsCache.defaultInterestRate ?? 2;
    const defaultPeriod = settingsCache.defaultRatePeriod || 'monthly';

    Modal.open({
      title: `New loan — ${borrower.fullName}`,
      bodyHtml: `
        <form id="l-form">
          <div class="form-grid cols-2">
            <div class="field">
              <label>Principal amount *</label>
              <input name="principal" type="number" step="0.01" min="0.01" required placeholder="e.g. 50000">
            </div>
            <div class="field">
              <label>Start date</label>
              <input name="startDate" type="date" value="${today}" max="${today}">
            </div>
            <div class="field">
              <label>Interest rate (%)</label>
              <input name="interestRate" type="number" step="0.01" min="0" value="${defaultRate}">
            </div>
            <div class="field">
              <label>Rate period</label>
              <select name="ratePeriod">
                <option value="monthly" ${defaultPeriod === 'monthly' ? 'selected' : ''}>Per month</option>
                <option value="daily" ${defaultPeriod === 'daily' ? 'selected' : ''}>Per day</option>
                <option value="yearly" ${defaultPeriod === 'yearly' ? 'selected' : ''}>Per year</option>
              </select>
            </div>
            <div class="field">
              <label>Payment frequency</label>
              <select name="paymentFrequency">
                <option value="monthly" selected>Monthly</option>
                <option value="weekly">Weekly</option>
                <option value="daily">Daily</option>
                <option value="custom">Custom (set due date by hand)</option>
              </select>
            </div>
            <div class="field">
              <label>Expected payment (optional)</label>
              <input name="expectedAmount" type="number" step="0.01" min="0.01" placeholder="e.g. 1000">
            </div>
            <div class="field">
              <label>Payout method</label>
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
            <div class="field" style="grid-column:1 / -1;">
              <label>Note (optional)</label>
              <textarea name="note" maxlength="500"></textarea>
            </div>
          </div>
        </form>
      `,
      footHtml: `
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="submit" form="l-form" class="btn btn-primary" id="l-save">Start loan</button>
      `,
      onMount: (body, foot, close) => {
        foot.querySelector('[data-cancel]').addEventListener('click', close);
        const form = body.querySelector('#l-form');
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('l-save');
          const principal = form.principal.value;
          if (!principal || Number(principal) <= 0) { UI.toast('Enter a valid principal amount'); return; }
          const payload = {
            principal: Number(principal),
            startDate: form.startDate.value || today,
            interestRate: form.interestRate.value === '' ? undefined : Number(form.interestRate.value),
            ratePeriod: form.ratePeriod.value,
            paymentFrequency: form.paymentFrequency.value,
            method: form.method.value,
          };
          if (form.expectedAmount.value) payload.expectedAmount = Number(form.expectedAmount.value);
          if (form.referenceNo.value.trim()) payload.referenceNo = form.referenceNo.value.trim();
          if (form.note.value.trim()) payload.note = form.note.value.trim();

          btn.disabled = true;
          btn.textContent = 'Starting…';
          try {
            await Api.post(`/api/borrowers/${borrower.id}/loans`, payload);
            close();
            UI.toast('Loan cycle started');
            openProfile(borrower.id);
          } catch (err) {
            UI.toast(err.message);
            btn.disabled = false;
            btn.textContent = 'Start loan';
          }
        });
      },
    });
  }

  return { render };
})();