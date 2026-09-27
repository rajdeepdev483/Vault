// =====================================================================
//  VAULT — Reminders screen (Step 7)
//  List / filter, add, edit, mark done, delete. Optionally linked to a
//  borrower (searches the same /api/search box used elsewhere).
// =====================================================================
'use strict';

const Reminders = (() => {
  let container = null;
  const S = { status: 'pending', items: [] };
  let searchDebounce = null;

  async function render(el) {
    container = el;
    S.status = 'pending';
    renderShell();
    await loadList();
  }

  function renderShell() {
    container.innerHTML = `
      <div class="fade-in">
        <div class="greeting" style="margin-bottom:14px;">
          <h2>Reminders</h2>
        </div>
        <div class="filter-row">
          <div class="segmented" id="r-segmented">
            <button data-v="pending" class="active">Pending</button>
            <button data-v="done">Done</button>
            <button data-v="all">All</button>
          </div>
        </div>
        <div id="r-list"></div>
      </div>
      <button class="fab" id="r-fab" aria-label="Add reminder" title="Add reminder">${UI.icon('plus', { size: 24 })}</button>
    `;
    document.getElementById('r-segmented').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn) return;
      document.querySelectorAll('#r-segmented button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      S.status = btn.dataset.v;
      loadList();
    });
    document.getElementById('r-fab').addEventListener('click', () => openForm(null));
  }

  function rowHtml(r, i) {
    const overdue = !r.isDone && r.remindOn < new Date().toISOString().slice(0, 10);
    return `
      <div class="borrower-row" data-id="${r.id}" style="animation-delay:${Math.min(i * 30, 240)}ms">
        <div class="avatar" style="${r.isDone ? 'opacity:.5;' : ''}">${UI.icon('bell', { size: 16 })}</div>
        <div class="info">
          <div class="name-row">
            <span class="name" style="${r.isDone ? 'text-decoration:line-through;color:var(--text-faint);' : ''}">${UI.escapeHtml(r.title)}</span>
            ${r.isDone ? '<span class="tag-pill archived-pill">Done</span>' : ''}
          </div>
          <div class="meta">
            ${[r.borrowerName, r.details].filter(Boolean).join(' · ') || 'No extra details'}
          </div>
        </div>
        <div class="side">
          <div class="due ${overdue ? 'overdue' : ''}">${UI.formatDateShort(r.remindOn)}</div>
        </div>
        <span class="chev">${UI.icon('chevron-right', { size: 18 })}</span>
      </div>
    `;
  }

  async function loadList(pulseId) {
    const listEl = document.getElementById('r-list');
    if (!listEl) return;
    listEl.innerHTML = Array.from({ length: 3 }).map(() => '<div class="skel skel-row"></div>').join('');
    let data;
    try {
      data = await Api.get(`/api/reminders?status=${S.status}&limit=200`);
    } catch (err) {
      listEl.innerHTML = `<div class="empty-state"><div class="glyph">${UI.icon('alert', { size: 26 })}</div><p>${UI.escapeHtml(err.message)}</p></div>`;
      return;
    }
    S.items = data.reminders;
    if (S.items.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="glyph">${UI.icon('bell', { size: 26 })}</div>
          <p>${S.status === 'pending' ? 'No pending reminders. Tap + to add one.' : 'Nothing here yet.'}</p>
        </div>`;
      return;
    }
    listEl.innerHTML = S.items.map(rowHtml).join('');
    listEl.querySelectorAll('.borrower-row').forEach((row) => {
      row.addEventListener('click', () => {
        const item = S.items.find((r) => r.id === Number(row.dataset.id));
        if (item) openMenu(item);
      });
    });
    if (pulseId) {
      const row = listEl.querySelector(`.borrower-row[data-id="${pulseId}"]`);
      if (row) UI.pulse(row);
    }
  }

  function openMenu(r) {
    const items = [
      r.isDone
        ? { key: 'reopen', icon: 'undo', label: 'Mark as pending' }
        : { key: 'done', icon: 'check-circle', label: 'Mark as done' },
      { key: 'edit', icon: 'edit', label: 'Edit reminder' },
      { key: 'delete', icon: 'ban', label: 'Delete reminder', danger: true },
    ];
    Modal.open({
      title: r.title,
      bodyHtml: `<div class="action-sheet-list">${items.map((it) => `
        <div class="action-sheet-item ${it.danger ? 'danger' : ''}" data-act="${it.key}">
          ${UI.icon(it.icon, { size: 17 })}<span>${it.label}</span>
        </div>`).join('')}</div>`,
      onMount: (body, foot, close) => {
        body.querySelectorAll('[data-act]').forEach((el) => {
          el.addEventListener('click', async () => {
            const act = el.dataset.act;
            close();
            if (act === 'edit') return openForm(r);
            if (act === 'delete') return doDelete(r);
            try {
              await Api.patch(`/api/reminders/${r.id}`, { isDone: act === 'done' });
              UI.toast(act === 'done' ? 'Marked as done' : 'Marked as pending');
              await loadList(r.id);
            } catch (err) { UI.toast(err.message); }
          });
        });
      },
    });
  }

  async function doDelete(r) {
    const ok = await Modal.confirm({
      title: 'Delete reminder?',
      message: `“${UI.escapeHtml(r.title)}” will be removed. This can't be undone from here.`,
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      await Api.del(`/api/reminders/${r.id}`);
      UI.toast('Reminder deleted');
      await loadList();
    } catch (err) { UI.toast(err.message); }
  }

  // -------------------------------------------------------------------
  // ADD / EDIT FORM (with an optional borrower link, searched live)
  // -------------------------------------------------------------------
  function openForm(existing) {
    let linked = existing && existing.borrowerId
      ? { id: existing.borrowerId, fullName: existing.borrowerName }
      : null;

    Modal.open({
      title: existing ? 'Edit reminder' : 'Add reminder',
      bodyHtml: `
        <form id="r-form">
          <div class="field">
            <label>Title *</label>
            <input name="title" maxlength="200" required value="${UI.escapeHtml(existing ? existing.title : '')}" placeholder="e.g. Call Ramesh about payment">
          </div>
          <div class="field">
            <label>Date *</label>
            <input name="remindOn" type="date" required value="${existing ? existing.remindOn : new Date().toISOString().slice(0, 10)}">
          </div>
          <div class="field">
            <label>Link to a borrower (optional)</label>
            <div class="search-bar" id="r-link-bar">
              ${UI.icon('search', { size: 16 })}
              <input id="r-link-input" type="text" placeholder="Search by name…" autocomplete="off" value="${linked ? UI.escapeHtml(linked.fullName) : ''}">
              <span class="clear-btn" id="r-link-clear" style="${linked ? '' : 'display:none;'}">${UI.icon('x', { size: 15 })}</span>
            </div>
            <div id="r-link-results" style="margin-top:4px;"></div>
          </div>
          <div class="field">
            <label>Details</label>
            <textarea name="details" maxlength="1000" placeholder="Optional notes">${UI.escapeHtml(existing ? existing.details || '' : '')}</textarea>
          </div>
        </form>
      `,
      footHtml: `
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="submit" form="r-form" class="btn btn-primary" id="r-save">${existing ? 'Save changes' : 'Add reminder'}</button>
      `,
      onMount: (body, foot, close) => {
        foot.querySelector('[data-cancel]').addEventListener('click', close);

        const linkInput = body.querySelector('#r-link-input');
        const linkClear = body.querySelector('#r-link-clear');
        const linkResults = body.querySelector('#r-link-results');
        linkInput.addEventListener('input', () => {
          linked = null;
          linkClear.style.display = 'none';
          clearTimeout(searchDebounce);
          const q = linkInput.value.trim();
          if (!q) { linkResults.innerHTML = ''; return; }
          searchDebounce = setTimeout(async () => {
            try {
              const { borrowers } = await Api.get(`/api/search?q=${encodeURIComponent(q)}`);
              linkResults.innerHTML = borrowers.length
                ? borrowers.map((b) => `<div class="action-sheet-item" data-pick="${b.id}" data-name="${UI.escapeHtml(b.fullName)}" style="padding:8px 4px;">${UI.escapeHtml(b.fullName)}<span style="color:var(--text-faint);margin-left:6px;">${UI.escapeHtml(b.phone || '')}</span></div>`).join('')
                : `<div style="color:var(--text-faint);font-size:13px;padding:6px 4px;">No matching borrowers</div>`;
              linkResults.querySelectorAll('[data-pick]').forEach((el) => {
                el.addEventListener('click', () => {
                  linked = { id: Number(el.dataset.pick), fullName: el.dataset.name };
                  linkInput.value = el.dataset.name;
                  linkClear.style.display = '';
                  linkResults.innerHTML = '';
                });
              });
            } catch (e) { /* ignore search errors here */ }
          }, 250);
        });
        linkClear.addEventListener('click', () => {
          linked = null;
          linkInput.value = '';
          linkClear.style.display = 'none';
          linkResults.innerHTML = '';
        });

        const form = body.querySelector('#r-form');
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('r-save');
          const title = form.title.value.trim();
          if (!title) { UI.toast('Title is required'); return; }
          const payload = {
            title,
            remindOn: form.remindOn.value,
            details: form.details.value.trim() || null,
            borrowerId: linked ? linked.id : null,
          };
          btn.disabled = true;
          btn.textContent = 'Saving…';
          try {
            let saved;
            if (existing) saved = await Api.patch(`/api/reminders/${existing.id}`, payload);
            else saved = await Api.post('/api/reminders', payload);
            close();
            UI.toast(existing ? 'Reminder updated' : 'Reminder added');
            await loadList(saved.reminder.id);
          } catch (err) {
            UI.toast(err.message);
            btn.disabled = false;
            btn.textContent = existing ? 'Save changes' : 'Add reminder';
          }
        });
      },
    });
  }

  return { render };
})();