// =====================================================================
//  VAULT — home dashboard screen
// =====================================================================
'use strict';

const Dashboard = (() => {
  let settings = null;

  function skeleton() {
    return `
      <div class="greeting">
        <div class="skel" style="width:120px;height:13px;margin-bottom:8px;"></div>
        <div class="skel" style="width:200px;height:26px;"></div>
      </div>
      <div class="stat-grid">
        ${Array.from({ length: 4 }).map(() => '<div class="skel skel-stat"></div>').join('')}
      </div>
      <div class="section">
        <div class="skel" style="width:100px;height:15px;margin-bottom:10px;"></div>
        ${Array.from({ length: 3 }).map(() => '<div class="skel skel-row"></div>').join('')}
      </div>
    `;
  }

  function notifChip(n) {
    return `<div class="notif-chip ${n.severity}"><span class="dot-ico"></span>${UI.escapeHtml(n.message)}</div>`;
  }

  function loanCard(item, kind) {
    const metaText =
      kind === 'overdue' ? `Overdue by ${item.daysOverdue} day${item.daysOverdue === 1 ? '' : 's'}` :
      kind === 'today' ? 'Due today' :
      `Due in ${item.daysUntil} day${item.daysUntil === 1 ? '' : 's'} · ${UI.formatDateShort(item.dueDate)}`;
    const metaClass = kind === 'overdue' ? 'warning' : '';
    return `
      <div class="loan-card">
        <div class="avatar">${UI.escapeHtml(UI.initials(item.borrowerName))}</div>
        <div class="info">
          <div class="name">${UI.escapeHtml(item.borrowerName)}</div>
          <div class="meta ${metaClass}">${metaText}</div>
        </div>
        <div class="amounts">
          <div class="expected">${UI.formatMoney(item.expectedAmount)}</div>
          <div class="outstanding">${UI.formatMoney(item.outstandingPrincipal, { decimals: 0 })} left</div>
        </div>
      </div>
    `;
  }

  function emptyState(iconName, text) {
    return `<div class="empty-state"><div class="glyph">${UI.icon(iconName, { size: 28, strokeWidth: 1.6 })}</div><p>${text}</p></div>`;
  }

  function section(title, count, bodyHtml) {
    return `
      <div class="section">
        <div class="section-head">
          <h3>${title}</h3>
          ${count !== undefined ? `<span class="count-pill">${count}</span>` : ''}
        </div>
        ${bodyHtml}
      </div>
    `;
  }

  function activityIcon(type) {
    if (type === 'disbursement' || type === 'topup') return { cls: 'out', icon: 'arrow-up-right' };
    return { cls: 'in', icon: 'arrow-down-left' };
  }
  function activityLabel(type) {
    return {
      disbursement: 'Loan given', topup: 'Top-up given',
      principal_payment: 'Principal received', interest_payment: 'Interest received',
    }[type] || type;
  }

  function compareRow(thisMonth, lastMonth) {
    const pct = (curr, prev) => {
      if (!prev) return null;
      return Math.round(((curr - prev) / prev) * 100);
    };
    const rows = [
      { label: 'Lent', curr: thisMonth.lent, prev: lastMonth.lent },
      { label: 'Principal in', curr: thisMonth.principalRepaid, prev: lastMonth.principalRepaid },
      { label: 'Interest in', curr: thisMonth.interestReceived, prev: lastMonth.interestReceived },
    ];
    return `
      <div class="compare-row">
        ${rows.map((r) => {
          const p = pct(r.curr, r.prev);
          const dir = p === null ? '' : p >= 0 ? 'up' : 'down';
          const vsText = p === null ? 'this month' : `${p >= 0 ? '+' : ''}${p}% vs last month`;
          return `
            <div class="compare-card">
              <div class="label">${r.label}</div>
              <div class="this-month">${UI.formatMoney(r.curr, { decimals: 0 })}</div>
              <div class="vs ${dir}">${vsText}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  async function render(container) {
    container.innerHTML = skeleton();

    let data, settingsResp;
    try {
      [data, settingsResp] = await Promise.all([
        Api.get('/api/dashboard'),
        Api.get('/api/settings'),
      ]);
    } catch (err) {
      container.innerHTML = emptyState('alert', err.message || 'Could not load the dashboard.');
      return;
    }

    settings = settingsResp.settings;
    UI.setCurrencySymbol(settings.currencySymbol);
    window.VaultApp.onSettingsLoaded(settings);

    const { summary, dueToday, overdue, upcoming, notifications, recentActivity } = data;

    const html = `
      <div class="greeting fade-in">
        <div class="eyebrow">${UI.greetingForHour()} · ${UI.formatDate(data.today)}</div>
        <h2>${UI.escapeHtml(settings.businessName)}</h2>
      </div>

      ${notifications.length ? `<div class="notif-strip">${notifications.slice(0, 8).map(notifChip).join('')}</div>` : ''}

      <div class="stat-grid">
        <div class="stat-card" style="animation-delay:0ms">
          <div class="label">Principal outstanding</div>
          <div class="value" id="stat-principal">${UI.formatMoney(0, { withSymbol: false })}</div>
        </div>
        <div class="stat-card" style="animation-delay:40ms">
          <div class="label">Monthly interest</div>
          <div class="value positive" id="stat-interest">${UI.formatMoney(0, { withSymbol: false })}</div>
        </div>
        <div class="stat-card" style="animation-delay:80ms">
          <div class="label">Interest pending</div>
          <div class="value ${summary.interestPending > 0 ? 'warning' : ''}" id="stat-pending">${UI.formatMoney(0, { withSymbol: false })}</div>
          <div class="sub">${summary.interestPending < 0 ? 'paid in advance' : 'as of today'}</div>
        </div>
        <div class="stat-card" style="animation-delay:120ms">
          <div class="label">Active borrowers</div>
          <div class="value">${summary.activeBorrowers}<span style="font-size:14px;color:var(--text-faint);"> / ${summary.totalBorrowers}</span></div>
          <div class="sub">${summary.activeLoans} active loan${summary.activeLoans === 1 ? '' : 's'}</div>
        </div>
      </div>

      <div class="quick-grid">
        <button class="quick-tile" data-go="borrowers"><span class="q-ico">${UI.icon('users', { size: 22 })}</span><span class="q-title">Borrowers</span><span class="q-sub">Add, find or open a borrower</span></button>
        <button class="quick-tile" data-go="loans"><span class="q-ico">${UI.icon('list', { size: 22 })}</span><span class="q-title">All loans</span><span class="q-sub">Every loan and its balance</span></button>
        <button class="quick-tile" data-go="reminders"><span class="q-ico">${UI.icon('clock', { size: 22 })}</span><span class="q-title">Collections</span><span class="q-sub">Who to collect from</span></button>
        <button class="quick-tile" data-go="settings"><span class="q-ico">${UI.icon('settings', { size: 22 })}</span><span class="q-title">Settings</span><span class="q-sub">Backup, password, theme</span></button>
      </div>

      ${section(
        'Overdue', overdue.length,
        overdue.length
          ? `<div class="loan-list">${overdue.map((i) => loanCard(i, 'overdue')).join('')}</div>`
          : emptyState('check-circle', 'Nothing overdue. Well done.')
      )}

      ${section(
        'Due today', dueToday.length,
        dueToday.length
          ? `<div class="loan-list">${dueToday.map((i) => loanCard(i, 'today')).join('')}</div>`
          : emptyState('sun', 'No payments due today.')
      )}

      ${section(
        `Upcoming (next ${data.upcomingDays} days)`, upcoming.length,
        upcoming.length
          ? `<div class="loan-list">${upcoming.map((i) => loanCard(i, 'upcoming')).join('')}</div>`
          : emptyState('calendar', 'Nothing coming up in this window.')
      )}

      ${section('This month', undefined, compareRow(summary.thisMonth, summary.lastMonth))}

      ${section(
        'Recent activity', undefined,
        recentActivity.length
          ? recentActivity.map((t) => {
              const ic = activityIcon(t.type);
              return `
                <div class="activity-row">
                  <div class="activity-icon ${ic.cls}">${UI.icon(ic.icon, { size: 16, strokeWidth: 2 })}</div>
                  <div class="info">
                    <div class="name">${UI.escapeHtml(t.borrowerName)}</div>
                    <div class="type">${activityLabel(t.type)} · ${UI.formatDateShort(t.date)}</div>
                  </div>
                  <div class="amt ${ic.cls}">${ic.cls === 'in' ? '+' : ''}${UI.formatMoney(t.amount, { decimals: 0 })}</div>
                </div>
              `;
            }).join('')
          : emptyState('inbox', 'No activity yet.')
      )}
    `;

    container.innerHTML = html;
    container.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => window.VaultApp.go(b.dataset.go)));

    // Staggered entrance + count-up on the big numbers
    document.getElementById('stat-principal') && UI.countUp(document.getElementById('stat-principal'), summary.principalOutstanding, { decimals: 0 });
    document.getElementById('stat-interest') && UI.countUp(document.getElementById('stat-interest'), summary.expectedMonthlyInterest, { decimals: 0 });
    document.getElementById('stat-pending') && UI.countUp(document.getElementById('stat-pending'), Math.abs(summary.interestPending), { decimals: 0 });

    container.querySelectorAll('.loan-card, .notif-chip').forEach((el, i) => {
      el.style.animationDelay = `${Math.min(i * 30, 300)}ms`;
    });

    return { notificationCount: data.counts.total };
  }

  return { render };
})();