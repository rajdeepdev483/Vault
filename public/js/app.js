// =====================================================================
//  VAULT — app bootstrap, shell, navigation
// =====================================================================
'use strict';

const NAV_ITEMS = [
  { id: 'home', label: 'Home', ready: true },
  { id: 'borrowers', label: 'Borrowers', ready: true },
  { id: 'loans', label: 'Loans', ready: true },
  { id: 'reminders', label: 'Reminders', ready: true },
  { id: 'settings', label: 'Settings', ready: true },
];

const VaultApp = (() => {
  const root = document.getElementById('app-root');
  let currentUser = null;
  let currentTab = 'home';
  let notificationCount = 0;

  async function boot() {
    let status;
    try {
      status = await Api.get('/api/auth/status');
    } catch (err) {
      root.innerHTML = `
        <div class="centered-screen">
          <div class="auth-card" style="text-align:center;">
            <div class="mark" style="margin:0 auto 14px;background:var(--warning-bg);color:var(--warning);">${UI.icon('alert', { size: 24 })}</div>
            <h1 style="margin-bottom:8px;">Vault can't start</h1>
            <p style="color:var(--text-muted);font-size:13.5px;margin-bottom:18px;">${UI.escapeHtml(err.message)}</p>
            <button class="btn btn-ghost" onclick="location.reload()">Try again</button>
          </div>
        </div>`;
      return;
    }

    if (status.setupRequired) {
      Auth.renderSetup({ setupCodeRequired: status.setupCodeRequired });
      return;
    }
    if (!status.user) {
      Auth.renderLogin();
      return;
    }
    onAuthenticated(status.user);
  }

  function onAuthenticated(user) {
    currentUser = user;
    renderShell();
    switchTab('home');
    registerServiceWorker();
  }

  function onSettingsLoaded(settings) {
    UI.applyTheme(settings.theme);
    const bizNameEls = document.querySelectorAll('[data-biz-name]');
    bizNameEls.forEach((el) => { el.textContent = settings.businessName; });
  }

  function iconSvg(id, opts) {
    const names = { home: 'home', borrowers: 'users', loans: 'list', reminders: 'clock', settings: 'settings' };
    return UI.icon(names[id] || 'settings', opts);
  }

  function renderShell() {
    root.innerHTML = `
      <div class="app-shell">
        <nav class="sidebar">
          <div class="brand-row">
            <div class="mark">V</div>
            <div>
              <div class="biz-name" data-biz-name>Vault</div>
              <div class="biz-name-sub">${UI.escapeHtml(currentUser.fullName || currentUser.username)}</div>
            </div>
          </div>
          ${NAV_ITEMS.map((n) => `
            <div class="nav-item ${n.ready ? '' : 'soon'}" data-tab="${n.id}">
              <span class="icon">${iconSvg(n.id)}</span>
              <span>${n.label}</span>
              ${n.id === 'reminders' ? '<span class="badge" id="sidebar-badge-reminders" style="display:none;"></span>' : ''}
            </div>
          `).join('')}
          <div style="flex:1;"></div>
          <div class="nav-item" data-action="logout">
            <span class="icon">${UI.icon('power', { size: 18 })}</span>
            <span>Log out</span>
          </div>
        </nav>

        <div class="main-col">
          <header class="top-bar">
            <div class="title" data-biz-name>Vault</div>
            <div class="actions">
              <button class="icon-btn" id="theme-toggle" title="Toggle theme" aria-label="Toggle theme">${UI.icon('theme', { size: 18 })}</button>
              <button class="icon-btn" id="notif-btn" title="Notifications" aria-label="Notifications">
                ${UI.icon('bell', { size: 18 })}
                <span class="dot" id="notif-dot" style="display:none;"></span>
              </button>
            </div>
          </header>
          <main class="content" id="tab-content"></main>
        </div>

        <nav class="tab-bar">
          ${NAV_ITEMS.map((n) => `
            <div class="tab-item" data-tab="${n.id}">
              <span class="icon">${iconSvg(n.id)}</span>
              <span>${n.label}</span>
              ${n.id === 'reminders' ? '<span class="badge" id="tabbar-badge-reminders" style="display:none;"></span>' : ''}
            </div>
          `).join('')}
        </nav>
      </div>
    `;

    root.querySelectorAll('[data-tab]').forEach((el) => {
      el.addEventListener('click', () => switchTab(el.dataset.tab));
    });
    root.querySelector('[data-action="logout"]').addEventListener('click', logout);
    document.getElementById('theme-toggle').addEventListener('click', cycleTheme);
    document.getElementById('notif-btn').addEventListener('click', () => {
      UI.toast(notificationCount > 0
        ? `${notificationCount} thing${notificationCount === 1 ? '' : 's'} need attention today`
        : 'No notifications right now');
    });
  }

  function setActiveNav(tab) {
    root.querySelectorAll('[data-tab]').forEach((el) => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
  }

  async function switchTab(tab) {
    currentTab = tab;
    setActiveNav(tab);
    const content = document.getElementById('tab-content');
    const item = NAV_ITEMS.find((n) => n.id === tab);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Brief fade-out of whatever's on screen before swapping content —
    // makes tab switches feel like one continuous motion instead of a snap.
    if (!reduce && content.childElementCount) {
      content.classList.remove('tab-entering');
      content.classList.add('tab-leaving');
      await UI.wait(90);
    }

    if (!item.ready) {
      content.innerHTML = `
        <div class="placeholder-screen">
          <div class="mark">${iconSvg(tab)}</div>
          <h3>${item.label} is coming soon</h3>
          <p>This screen is being built next. Everything here will be editable right from the app.</p>
        </div>
      `;
    } else if (tab === 'home') {
      const result = await Dashboard.render(content);
      if (result) updateNotifBadge(result.notificationCount);
    } else if (tab === 'borrowers') {
      await Borrowers.render(content);
    } else if (tab === 'loans') {
      await Loans.render(content);
    } else if (tab === 'reminders') {
      await Reminders.render(content);
    } else if (tab === 'settings') {
      await Settings.render(content);
    }

    content.classList.remove('tab-leaving');
    if (!reduce) {
      void content.offsetWidth; // restart the entrance animation each time
      content.classList.add('tab-entering');
    }
  }

  function updateNotifBadge(count) {
    notificationCount = count || 0;
    const dot = document.getElementById('notif-dot');
    if (dot) {
      if (notificationCount > 0) {
        dot.textContent = notificationCount > 9 ? '9+' : String(notificationCount);
        dot.style.display = 'flex';
      } else {
        dot.style.display = 'none';
      }
    }
  }

  function cycleTheme() {
    const order = ['system', 'dark', 'light'];
    const current = document.documentElement.getAttribute('data-theme') || 'system';
    const next = order[(order.indexOf(current) + 1) % order.length];
    UI.applyTheme(next);
    Api.patch('/api/settings', { theme: next }).catch(() => {});
    UI.toast(`Theme: ${next}`);
  }

  async function logout() {
    try {
      await Api.post('/api/auth/logout');
    } catch (e) { /* log out locally regardless */ }
    currentUser = null;
    Auth.renderLogin();
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  return { boot, onAuthenticated, onSettingsLoaded, go: switchTab };
})();

window.VaultApp = VaultApp;
document.addEventListener('DOMContentLoaded', VaultApp.boot);