// =====================================================================
//  VAULT — Settings screen (Step 7) + Backups & data (Step 8)
// =====================================================================
'use strict';

const Settings = (() => {
  let container = null;
  let settings = null;
  let me = null;

  async function render(el) {
    container = el;
    container.innerHTML = `
      <div class="greeting" style="margin-bottom:14px;"><h2>Settings</h2></div>
      <div class="section"><div class="skel skel-row"></div><div class="skel skel-row"></div></div>
    `;

    let settingsResp, meResp;
    try {
      [settingsResp, meResp] = await Promise.all([Api.get('/api/settings'), Api.get('/api/auth/me')]);
    } catch (err) {
      container.innerHTML = `<div class="empty-state"><div class="glyph">${UI.icon('alert', { size: 26 })}</div><p>${UI.escapeHtml(err.message)}</p></div>`;
      return;
    }
    settings = settingsResp.settings;
    me = meResp.user;
    UI.setCurrencySymbol(settings.currencySymbol);
    draw();
  }

  function section(title, bodyHtml) {
    return `
      <div class="section">
        <div class="section-head"><h3>${title}</h3></div>
        ${bodyHtml}
      </div>
    `;
  }

  function draw() {
    container.innerHTML = `
      <div class="fade-in">
        <div class="greeting" style="margin-bottom:14px;"><h2>Settings</h2></div>

        ${section('Business', `
          <div class="profile-card">
            <form id="biz-form">
              <div class="form-grid cols-2">
                <div class="field">
                  <label>Business name</label>
                  <input name="businessName" maxlength="80" value="${UI.escapeHtml(settings.businessName)}">
                </div>
                <div class="field">
                  <label>Currency symbol</label>
                  <input name="currencySymbol" maxlength="5" value="${UI.escapeHtml(settings.currencySymbol)}">
                </div>
                <div class="field">
                  <label>Default interest rate (%)</label>
                  <input name="defaultInterestRate" type="number" step="0.01" min="0" max="1000" value="${settings.defaultInterestRate}">
                </div>
                <div class="field">
                  <label>Default rate period</label>
                  <select name="defaultRatePeriod">
                    <option value="monthly" ${settings.defaultRatePeriod === 'monthly' ? 'selected' : ''}>Per month</option>
                    <option value="daily" ${settings.defaultRatePeriod === 'daily' ? 'selected' : ''}>Per day</option>
                    <option value="yearly" ${settings.defaultRatePeriod === 'yearly' ? 'selected' : ''}>Per year</option>
                  </select>
                </div>
                <div class="field">
                  <label>"Upcoming" window (days)</label>
                  <input name="upcomingDays" type="number" min="1" max="60" value="${settings.upcomingDays}">
                </div>
              </div>
              <button type="submit" class="btn btn-primary" id="biz-save" style="width:auto;padding:10px 20px;margin-top:12px;">Save changes</button>
            </form>
          </div>
        `)}

        ${section('Appearance', `
          <div class="profile-card">
            <div class="field" style="margin-bottom:0;">
              <label>Theme</label>
              <div class="segmented" id="theme-segmented">
                <button data-v="dark" class="${settings.theme === 'dark' ? 'active' : ''}">Dark</button>
                <button data-v="light" class="${settings.theme === 'light' ? 'active' : ''}">Light</button>
                <button data-v="system" class="${settings.theme === 'system' ? 'active' : ''}">System</button>
              </div>
            </div>
          </div>
        `)}

        ${section('Backups & data', `
          <div class="profile-card">
            <div class="detail-grid" id="backup-status">
              <div class="d-item"><div class="d-label">Automatic backups</div><div class="d-value">Checking…</div></div>
            </div>
            <button type="button" class="btn btn-primary" id="download-backup-btn" style="width:auto;padding:10px 20px;margin-top:14px;">
              ${UI.icon('archive', { size: 16 })}&nbsp; Download full backup
            </button>
            <p style="color:var(--text-muted);font-size:12.5px;margin-top:10px;line-height:1.5;">
              This downloads a complete, up-to-the-minute copy of your data as one file. Keep a copy somewhere safe
              (a pen drive, cloud drive, or email to yourself) — it's the fastest way to recover everything if this
              computer is ever lost, stolen, or damaged.
            </p>
          </div>
        `)}

        ${section('Account', `
          <div class="profile-card">
            <form id="account-form">
              <div class="form-grid cols-2">
                <div class="field">
                  <label>Full name</label>
                  <input name="fullName" maxlength="80" value="${UI.escapeHtml(me.fullName || '')}">
                </div>
                <div class="field">
                  <label>Username</label>
                  <input name="username" maxlength="30" value="${UI.escapeHtml(me.username)}">
                  <div style="color:var(--text-muted);font-size:12px;margin-top:4px;">Changing this needs your current password.</div>
                </div>
              </div>
              <button type="submit" class="btn btn-primary" id="account-save" style="width:auto;padding:10px 20px;margin-top:12px;">Save changes</button>
            </form>
            <button type="button" class="btn btn-ghost" id="change-pw-btn" style="width:auto;padding:9px 18px;margin-top:14px;">Change password</button>
          </div>
        `)}

        ${section('Signed-in devices', `
          <div class="profile-card">
            <div id="sessions-list"><div class="skel skel-row"></div></div>
            <button type="button" class="btn btn-ghost" id="signout-others-btn" style="width:auto;padding:9px 18px;margin-top:14px;">Sign out all other devices</button>
          </div>
        `)}
      </div>
    `;

    bindBusinessForm();
    bindAccountForm();
    bindTheme();
    loadBackupStatus();
    loadSessions();
    document.getElementById('download-backup-btn').addEventListener('click', downloadBackup);
    document.getElementById('change-pw-btn').addEventListener('click', openChangePassword);
    document.getElementById('signout-others-btn').addEventListener('click', signOutOthers);
  }

  function describeDevice(userAgent) {
    const ua = userAgent || '';
    let device = 'Unknown device';
    if (/android/i.test(ua)) device = 'Android device';
    else if (/iphone|ipad/i.test(ua)) device = 'iPhone/iPad';
    else if (/windows/i.test(ua)) device = 'Windows computer';
    else if (/mac os/i.test(ua)) device = 'Mac';
    else if (/linux/i.test(ua)) device = 'Linux computer';
    let browser = '';
    if (/edg\//i.test(ua)) browser = 'Edge';
    else if (/chrome\//i.test(ua)) browser = 'Chrome';
    else if (/firefox\//i.test(ua)) browser = 'Firefox';
    else if (/safari\//i.test(ua)) browser = 'Safari';
    return browser ? `${device} · ${browser}` : device;
  }

  async function loadSessions() {
    const el = document.getElementById('sessions-list');
    if (!el) return;
    try {
      const { sessions } = await Api.get('/api/auth/sessions');
      el.innerHTML = sessions.map((s) => `
        <div class="d-item" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div>
            <div class="d-value">${UI.escapeHtml(describeDevice(s.userAgent))}${s.isCurrent ? ' <span style="color:var(--accent);font-size:12px;">(this device)</span>' : ''}</div>
            <div class="d-label">${s.ipAddress ? UI.escapeHtml(s.ipAddress) + ' · ' : ''}Signed in ${UI.formatDate((s.createdAt || '').slice(0, 10))}</div>
          </div>
          ${s.isCurrent ? '' : `<button type="button" class="btn-text session-revoke" data-id="${UI.escapeHtml(s.id)}" style="color:var(--danger,#e5484d);flex-shrink:0;">Sign out</button>`}
        </div>
      `).join('') || `<div class="d-item"><div class="d-value empty">No active sessions</div></div>`;

      el.querySelectorAll('.session-revoke').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await Api.del(`/api/auth/sessions/${btn.dataset.id}`);
            loadSessions();
          } catch (err) {
            UI.toast(err.message);
            btn.disabled = false;
          }
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="d-item"><div class="d-value empty">Could not load sessions right now</div></div>`;
    }
  }

  async function signOutOthers() {
    const btn = document.getElementById('signout-others-btn');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Signing out…';
    try {
      await Api.del('/api/auth/sessions');
      UI.toast('Signed out on every other device');
      loadSessions();
    } catch (err) {
      UI.toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function bindAccountForm() {
    const form = document.getElementById('account-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fullName = form.fullName.value.trim();
      const username = form.username.value.trim().toLowerCase();
      const fullNameChanged = fullName !== (me.fullName || '');
      const usernameChanged = username !== me.username;

      if (!fullNameChanged && !usernameChanged) { UI.toast('No changes to save'); return; }

      if (usernameChanged) {
        openConfirmUsername({ fullName, fullNameChanged, username });
        return;
      }

      const btn = document.getElementById('account-save');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const { user } = await Api.patch('/api/auth/me', { fullName });
        me = user;
        UI.toast('Account updated');
      } catch (err) {
        UI.toast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save changes';
      }
    });
  }

  // Changing the username doubles as your login ID, so this asks for the
  // current password first — the same safeguard as the password-change flow.
  function openConfirmUsername({ fullName, fullNameChanged, username }) {
    Modal.open({
      title: 'Confirm username change',
      bodyHtml: `
        <form id="username-confirm-form">
          <p style="color:var(--text-muted);font-size:13px;">
            You're changing your username to <strong>${UI.escapeHtml(username)}</strong>. Enter your current
            password to confirm — you'll use the new username next time you log in.
          </p>
          <div class="field"><label>Current password</label><input name="currentPassword" type="password" required autocomplete="current-password"></div>
        </form>
      `,
      footHtml: `
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="submit" form="username-confirm-form" class="btn btn-primary" id="username-confirm-save">Confirm change</button>
      `,
      onMount: (body, foot, close) => {
        foot.querySelector('[data-cancel]').addEventListener('click', close);
        UI.attachPasswordToggles(body);
        const form = body.querySelector('#username-confirm-form');
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('username-confirm-save');
          btn.disabled = true;
          btn.textContent = 'Saving…';
          try {
            const payload = { username, currentPassword: form.currentPassword.value };
            if (fullNameChanged) payload.fullName = fullName;
            const { user } = await Api.patch('/api/auth/me', payload);
            me = user;
            close();
            draw();
            UI.toast('Account updated');
          } catch (err) {
            UI.toast(err.message);
            btn.disabled = false;
            btn.textContent = 'Confirm change';
          }
        });
      },
    });
  }

  function bindBusinessForm() {
    const form = document.getElementById('biz-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('biz-save');
      const payload = {
        businessName: form.businessName.value.trim(),
        currencySymbol: form.currencySymbol.value.trim(),
        defaultInterestRate: Number(form.defaultInterestRate.value),
        defaultRatePeriod: form.defaultRatePeriod.value,
        upcomingDays: Number(form.upcomingDays.value),
      };
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const { settings: updated } = await Api.patch('/api/settings', payload);
        settings = updated;
        UI.setCurrencySymbol(settings.currencySymbol);
        window.VaultApp.onSettingsLoaded(settings);
        UI.toast('Settings saved');
      } catch (err) {
        UI.toast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save changes';
      }
    });
  }

  function bindTheme() {
    document.getElementById('theme-segmented').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn) return;
      document.querySelectorAll('#theme-segmented button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const theme = btn.dataset.v;
      UI.applyTheme(theme);
      try {
        const { settings: updated } = await Api.patch('/api/settings', { theme });
        settings = updated;
      } catch (err) { UI.toast(err.message); }
    });
  }

  async function loadBackupStatus() {
    const el = document.getElementById('backup-status');
    if (!el) return;
    try {
      const status = await Api.get('/api/backup/status');
      const auto = status.automaticBackups;
      const latestText = auto.latest
        ? `${UI.formatDate(auto.latest.createdAt.slice(0, 10))} · ${Math.round(auto.latest.sizeBytes / 1024)} KB`
        : 'None yet';
      el.innerHTML = `
        <div class="d-item"><div class="d-label">Last automatic backup</div><div class="d-value">${latestText}</div></div>
        <div class="d-item"><div class="d-label">Kept locally</div><div class="d-value">${auto.count} of last ${auto.keepDays} days</div></div>
        <div class="d-item"><div class="d-label">Off-site copy</div><div class="d-value">${status.offsite.configured ? 'Configured (' + UI.escapeHtml(status.offsite.provider) + ')' : 'Not set up'}</div></div>
      `;
    } catch (err) {
      el.innerHTML = `<div class="d-item"><div class="d-label">Automatic backups</div><div class="d-value empty">Could not check right now</div></div>`;
    }
  }

  function downloadBackup() {
    const btn = document.getElementById('download-backup-btn');
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = 'Preparing…';
    // A plain navigation (not fetch) lets the browser handle the file
    // download and Content-Disposition header directly.
    window.location.href = '/api/backup/download';
    setTimeout(() => { btn.disabled = false; btn.innerHTML = original; }, 1500);
  }

  function openChangePassword() {
    Modal.open({
      title: 'Change password',
      bodyHtml: `
        <form id="pw-form">
          <div class="field"><label>Current password</label><input name="currentPassword" type="password" required autocomplete="current-password"></div>
          <div class="field"><label>New password</label><input name="newPassword" type="password" required minlength="8" autocomplete="new-password"></div>
          <div class="field"><label>Confirm new password</label><input name="confirmPassword" type="password" required minlength="8" autocomplete="new-password"></div>
          <p style="color:var(--text-muted);font-size:12.5px;">Changing your password signs you out on every other device.</p>
        </form>
      `,
      footHtml: `
        <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
        <button type="submit" form="pw-form" class="btn btn-primary" id="pw-save">Change password</button>
      `,
      onMount: (body, foot, close) => {
        foot.querySelector('[data-cancel]').addEventListener('click', close);
        const form = body.querySelector('#pw-form');
        UI.attachPasswordToggles(body);
        UI.attachStrengthMeter(form.newPassword);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('pw-save');
          if (form.newPassword.value !== form.confirmPassword.value) { UI.toast("New passwords don't match"); return; }
          btn.disabled = true;
          btn.textContent = 'Saving…';
          try {
            await Api.post('/api/auth/change-password', {
              currentPassword: form.currentPassword.value,
              newPassword: form.newPassword.value,
            });
            close();
            UI.toast('Password changed');
          } catch (err) {
            UI.toast(err.message);
            btn.disabled = false;
            btn.textContent = 'Change password';
          }
        });
      },
    });
  }

  return { render };
})();