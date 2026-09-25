// =====================================================================
//  VAULT — first-time setup, login (with email OTP), and email
//  verification (used for sign-up, every login, and password reset)
// =====================================================================
'use strict';

const Auth = (() => {
  const root = document.getElementById('app-root');
  const RESEND_SECONDS = 45;

  // -------------------------------------------------------------------
  // SETUP (first account) — email verified by OTP, then account details
  // -------------------------------------------------------------------
  function renderSetup({ setupCodeRequired }) {
    renderEmailEntry({
      purpose: 'signup',
      title: 'Set up Vault',
      subtitle: 'First, verify your email address. A code will be sent there to confirm it.',
      onSent: (email) => {
        renderOtpEntry({
          purpose: 'signup',
          email,
          title: 'Verify your email',
          onVerified: (verificationToken) => renderSetupDetails({ email, verificationToken, setupCodeRequired }),
          onChangeAddress: () => renderSetup({ setupCodeRequired }),
        });
      },
    });
  }

  function renderSetupDetails({ email, verificationToken, setupCodeRequired, showLoginLink }) {
    root.innerHTML = `
      <div class="centered-screen">
        <div class="auth-card">
          <div class="auth-brand">
            <div class="mark">V</div>
            <h1>Create your account</h1>
            <p>Email verified — ${UI.escapeHtml(email)}. ${showLoginLink ? 'Your borrowers and loans stay private to this account.' : 'This account has full access.'}</p>
          </div>
          <div id="auth-error" class="error-banner"></div>
          <form id="setup-form" novalidate>
            <div class="field">
              <label for="fullName">Full name</label>
              <input id="fullName" name="fullName" autocomplete="name" required maxlength="80" placeholder="e.g. Harpreet Singh">
            </div>
            <div class="field">
              <label for="username">Username</label>
              <input id="username" name="username" autocomplete="username" required maxlength="30" placeholder="letters, numbers, . _ -">
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8" placeholder="At least 8 characters">
            </div>
            <div class="field">
              <label for="confirmPassword">Confirm password</label>
              <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required minlength="8" placeholder="Type it again">
            </div>
            ${setupCodeRequired ? `
            <div class="field">
              <label for="setupCode">Setup code</label>
              <input id="setupCode" name="setupCode" required placeholder="Given to you when the site was set up">
            </div>` : ''}
            <button type="submit" class="btn btn-primary" id="setup-submit">
              <span class="btn-label">Create account</span>
            </button>
          </form>
          <div class="switch-row">
            <button type="button" class="btn-text" id="change-email-btn">Use a different email</button>
          </div>
        </div>
      </div>
    `;

    const form = document.getElementById('setup-form');
    UI.attachPasswordToggles(form);
    UI.attachStrengthMeter(form.password);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();
      if (form.password.value !== form.confirmPassword.value) {
        showError('Those two passwords do not match.');
        return;
      }
      const btn = document.getElementById('setup-submit');
      setLoading(btn, true);
      try {
        const body = {
          fullName: form.fullName.value.trim(),
          username: form.username.value.trim(),
          password: form.password.value,
          email,
          verificationToken,
        };
        if (setupCodeRequired) body.setupCode = form.setupCode.value;
        const { user } = await Api.post('/api/auth/setup', body);
        window.VaultApp.onAuthenticated(user);
      } catch (err) {
        showError(err.message);
        setLoading(btn, false);
      }
    });

    document.getElementById('change-email-btn').addEventListener('click', () => {
      if (showLoginLink) renderSignup();
      else renderSetup({ setupCodeRequired });
    });
    if (showLoginLink) {
      const row = document.querySelector('.switch-row');
      if (row) row.insertAdjacentHTML('beforeend', ' &nbsp;&middot;&nbsp; <button type="button" class="btn-text" id="login-instead-btn">Log in instead</button>');
      const loginBtn = document.getElementById('login-instead-btn');
      if (loginBtn) loginBtn.addEventListener('click', () => renderLogin());
    }
    setTimeout(() => form.fullName.focus(), 50);
  }

  // -------------------------------------------------------------------
  // SIGN UP (any time) — same email-OTP flow as first-time setup, but
  // available after accounts already exist. Each new account's data is
  // private to it (see server-side owner_id isolation).
  // -------------------------------------------------------------------
  function renderSignup() {
    renderEmailEntry({
      purpose: 'signup',
      title: 'Create your account',
      subtitle: 'First, verify your email address. Your borrowers and loans stay private to your account.',
      showBackToLogin: true,
      onSent: (email) => {
        renderOtpEntry({
          purpose: 'signup',
          email,
          title: 'Verify your email',
          onVerified: (verificationToken) =>
            renderSetupDetails({ email, verificationToken, setupCodeRequired: false, showLoginLink: true }),
          onChangeAddress: () => renderSignup(),
        });
      },
    });
  }

  // -------------------------------------------------------------------
  // LOGIN — step 1: username + password. Step 2: a fresh code emailed to
  // the account's address (sent every time, including right after a
  // logout) must be entered before a session actually starts.
  // -------------------------------------------------------------------
  function renderLogin({ prefillUsername } = {}) {
    root.innerHTML = `
      <div class="centered-screen">
        <div class="auth-card">
          <div class="auth-brand">
            <div class="mark">V</div>
            <h1>Welcome back</h1>
            <p>Log in to manage your loans.</p>
          </div>
          <div id="auth-error" class="error-banner"></div>
          <form id="login-form" novalidate>
            <div class="field">
              <label for="username">Username</label>
              <input id="username" name="username" autocomplete="username" required value="${UI.escapeHtml(prefillUsername || '')}">
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" autocomplete="current-password" required>
            </div>
            <button type="submit" class="btn btn-primary" id="login-submit">
              <span class="btn-label">Log in</span>
            </button>
          </form>
          <div class="switch-row">
            <button type="button" class="btn-text" id="forgot-password-link">Forgot password?</button>
            &nbsp;&middot;&nbsp;
            <button type="button" class="btn-text" id="signup-link">Sign up</button>
          </div>
        </div>
      </div>
    `;

    const form = document.getElementById('login-form');
    UI.attachPasswordToggles(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();
      const btn = document.getElementById('login-submit');
      setLoading(btn, true);
      const username = form.username.value.trim();
      const password = form.password.value;
      try {
        const result = await Api.post('/api/auth/login', { username, password });
        if (result && result.otpRequired) {
          renderLoginOtpEntry({
            email: result.email,
            requestOtp: () => Api.post('/api/auth/login', { username, password }),
          });
          return;
        }
        window.VaultApp.onAuthenticated(result.user);
      } catch (err) {
        showError(err.message);
        setLoading(btn, false);
        form.password.value = '';
        form.password.focus();
      }
    });

    document.getElementById('forgot-password-link').addEventListener('click', () => renderForgotPassword());
    document.getElementById('signup-link').addEventListener('click', () => renderSignup());

    setTimeout(() => {
      if (!form.username.value) form.username.focus();
      else form.password.focus();
    }, 50);
  }

  // Shows only the first couple of characters of the mailbox name, so the
  // screen doesn't need to spell out the full address to confirm where
  // the code went.
  function maskEmailForDisplay(email) {
    const at = email.indexOf('@');
    if (at <= 0) return email;
    const name = email.slice(0, at);
    const domain = email.slice(at + 1);
    const visible = name.slice(0, Math.min(2, name.length));
    return `${visible}${'*'.repeat(Math.max(name.length - visible.length, 3))}@${domain}`;
  }

  // The second login step. The code was already sent by the /api/auth/login
  // call that got us here.
  function renderLoginOtpEntry({ email, requestOtp }) {
    root.innerHTML = `
      <div class="centered-screen">
        <div class="auth-card">
          <div class="auth-brand">
            <div class="mark">V</div>
            <h1>Check your email</h1>
            <p>Enter the 6-digit code sent to ${UI.escapeHtml(maskEmailForDisplay(email))}</p>
          </div>
          <div id="auth-error" class="error-banner"></div>
          <form id="login-otp-form" novalidate>
            <div class="field">
              <label for="code">Verification code</label>
              <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"
                     required maxlength="6" placeholder="000000"
                     style="letter-spacing:6px;text-align:center;font-size:20px;">
            </div>
            <button type="submit" class="btn btn-primary" id="login-otp-submit">
              <span class="btn-label">Verify &amp; log in</span>
            </button>
          </form>
          <div class="switch-row">
            <button type="button" class="btn-text" id="resend-btn" disabled>Resend code (<span id="resend-timer">${RESEND_SECONDS}</span>s)</button>
            &nbsp;&middot;&nbsp;
            <button type="button" class="btn-text" id="back-to-login">Back to login</button>
          </div>
        </div>
      </div>
    `;

    const form = document.getElementById('login-otp-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();
      const code = form.code.value.trim();
      if (!/^\d{6}$/.test(code)) {
        showError('Enter the 6-digit code.');
        return;
      }
      const btn = document.getElementById('login-otp-submit');
      setLoading(btn, true);
      try {
        const { verificationToken } = await Api.post('/api/auth/otp/verify', { purpose: 'login', email, code });
        const { user } = await Api.post('/api/auth/login/complete', { email, verificationToken });
        window.VaultApp.onAuthenticated(user);
      } catch (err) {
        showError(err.message);
        setLoading(btn, false);
        form.code.value = '';
        form.code.focus();
      }
    });

    document.getElementById('back-to-login').addEventListener('click', () => renderLogin());

    let remaining = RESEND_SECONDS;
    const resendBtn = document.getElementById('resend-btn');
    const timerEl = document.getElementById('resend-timer');
    const tick = setInterval(() => {
      if (!document.getElementById('resend-btn')) { clearInterval(tick); return; }
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(tick);
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend code';
      } else {
        timerEl.textContent = String(remaining);
      }
    }, 1000);

    resendBtn.addEventListener('click', async () => {
      hideError();
      resendBtn.disabled = true;
      try {
        await requestOtp();
        remaining = RESEND_SECONDS;
        resendBtn.innerHTML = `Resend code (<span id="resend-timer">${RESEND_SECONDS}</span>s)`;
      } catch (err) {
        showError(err.message);
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend code';
      }
    });

    setTimeout(() => form.code.focus(), 50);
  }

  // -------------------------------------------------------------------
  // FORGOT PASSWORD — same email (OTP) verification, then a new password
  // -------------------------------------------------------------------
  function renderForgotPassword() {
    renderEmailEntry({
      purpose: 'reset',
      title: 'Reset your password',
      subtitle: 'Enter the email address linked to your account.',
      onSent: (email) => {
        renderOtpEntry({
          purpose: 'reset',
          email,
          title: 'Verify your email',
          onVerified: (verificationToken) => renderNewPassword({ email, verificationToken }),
          onChangeAddress: () => renderForgotPassword(),
        });
      },
    });
  }

  function renderNewPassword({ email, verificationToken }) {
    root.innerHTML = `
      <div class="centered-screen">
        <div class="auth-card">
          <div class="auth-brand">
            <div class="mark">V</div>
            <h1>Choose a new password</h1>
            <p>Email verified — ${UI.escapeHtml(email)}.</p>
          </div>
          <div id="auth-error" class="error-banner"></div>
          <form id="reset-form" novalidate>
            <div class="field">
              <label for="newPassword">New password</label>
              <input id="newPassword" name="newPassword" type="password" autocomplete="new-password" required minlength="8" placeholder="At least 8 characters">
            </div>
            <div class="field">
              <label for="confirmPassword">Confirm new password</label>
              <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required minlength="8" placeholder="Type it again">
            </div>
            <button type="submit" class="btn btn-primary" id="reset-submit">
              <span class="btn-label">Reset password</span>
            </button>
          </form>
        </div>
      </div>
    `;

    const form = document.getElementById('reset-form');
    UI.attachPasswordToggles(form);
    UI.attachStrengthMeter(form.newPassword);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();
      if (form.newPassword.value !== form.confirmPassword.value) {
        showError('Those two passwords do not match.');
        return;
      }
      const btn = document.getElementById('reset-submit');
      setLoading(btn, true);
      try {
        const result = await Api.post('/api/auth/forgot-password/reset', {
          email,
          verificationToken,
          newPassword: form.newPassword.value,
        });
        renderResetDone(result.username);
      } catch (err) {
        showError(err.message);
        setLoading(btn, false);
      }
    });
    setTimeout(() => form.newPassword.focus(), 50);
  }

  function renderResetDone(username) {
    root.innerHTML = `
      <div class="centered-screen">
        <div class="auth-card">
          <div class="auth-brand">
            <div class="mark">V</div>
            <h1>Password updated</h1>
            <p>You can now log in as <strong>${UI.escapeHtml(username)}</strong> with your new password. You've been signed out everywhere else, for safety.</p>
          </div>
          <button type="button" class="btn btn-primary" id="continue-to-login">
            <span class="btn-label">Continue to login</span>
          </button>
        </div>
      </div>
    `;
    document.getElementById('continue-to-login').addEventListener('click', () => renderLogin({ prefillUsername: username }));
  }

  // -------------------------------------------------------------------
  // SHARED: email entry + OTP entry (used by setup, sign-up, and reset)
  // -------------------------------------------------------------------
  function renderEmailEntry({ purpose, title, subtitle, onSent, showBackToLogin }) {
    const showBack = showBackToLogin !== undefined ? showBackToLogin : purpose === 'reset';
    root.innerHTML = `
      <div class="centered-screen">
        <div class="auth-card">
          <div class="auth-brand">
            <div class="mark">V</div>
            <h1>${UI.escapeHtml(title)}</h1>
            <p>${UI.escapeHtml(subtitle)}</p>
          </div>
          <div id="auth-error" class="error-banner"></div>
          <form id="email-form" novalidate>
            <div class="field">
              <label for="email">Email address</label>
              <input id="email" name="email" type="email" inputmode="email" autocomplete="email" required placeholder="you@example.com">
              <div class="hint">We'll email a 6-digit code to this address.</div>
            </div>
            <button type="submit" class="btn btn-primary" id="email-submit">
              <span class="btn-label">Send code</span>
            </button>
          </form>
          ${showBack ? `
          <div class="switch-row">
            <button type="button" class="btn-text" id="back-to-login">Back to login</button>
          </div>` : ''}
        </div>
      </div>
    `;

    const form = document.getElementById('email-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();
      const email = form.email.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showError('Enter a valid email address.');
        return;
      }
      const btn = document.getElementById('email-submit');
      setLoading(btn, true);
      try {
        await Api.post('/api/auth/otp/request', { purpose, email });
        onSent(email);
      } catch (err) {
        showError(err.message);
        setLoading(btn, false);
      }
    });

    const backBtn = document.getElementById('back-to-login');
    if (backBtn) backBtn.addEventListener('click', () => renderLogin());

    setTimeout(() => form.email.focus(), 50);
  }

  function renderOtpEntry({ purpose, email, title, onVerified, onChangeAddress }) {
    root.innerHTML = `
      <div class="centered-screen">
        <div class="auth-card">
          <div class="auth-brand">
            <div class="mark">V</div>
            <h1>${UI.escapeHtml(title)}</h1>
            <p>Enter the 6-digit code sent to ${UI.escapeHtml(email)}</p>
          </div>
          <div id="auth-error" class="error-banner"></div>
          <form id="otp-form" novalidate>
            <div class="field">
              <label for="code">Verification code</label>
              <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"
                     required maxlength="6" placeholder="000000"
                     style="letter-spacing:6px;text-align:center;font-size:20px;">
            </div>
            <button type="submit" class="btn btn-primary" id="otp-submit">
              <span class="btn-label">Verify</span>
            </button>
          </form>
          <div class="switch-row">
            <button type="button" class="btn-text" id="resend-btn" disabled>Resend code (<span id="resend-timer">${RESEND_SECONDS}</span>s)</button>
            &nbsp;&middot;&nbsp;
            <button type="button" class="btn-text" id="change-email-btn">Change email</button>
          </div>
        </div>
      </div>
    `;

    const form = document.getElementById('otp-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();
      const code = form.code.value.trim();
      if (!/^\d{6}$/.test(code)) {
        showError('Enter the 6-digit code.');
        return;
      }
      const btn = document.getElementById('otp-submit');
      setLoading(btn, true);
      try {
        const { verificationToken } = await Api.post('/api/auth/otp/verify', { purpose, email, code });
        onVerified(verificationToken);
      } catch (err) {
        showError(err.message);
        setLoading(btn, false);
        form.code.value = '';
        form.code.focus();
      }
    });

    document.getElementById('change-email-btn').addEventListener('click', onChangeAddress);

    // Resend cooldown timer
    let remaining = RESEND_SECONDS;
    const resendBtn = document.getElementById('resend-btn');
    const timerEl = document.getElementById('resend-timer');
    const tick = setInterval(() => {
      if (!document.getElementById('resend-btn')) { clearInterval(tick); return; } // screen changed
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(tick);
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend code';
      } else {
        timerEl.textContent = String(remaining);
      }
    }, 1000);

    resendBtn.addEventListener('click', async () => {
      hideError();
      resendBtn.disabled = true;
      try {
        await Api.post('/api/auth/otp/request', { purpose, email });
        remaining = RESEND_SECONDS;
        resendBtn.innerHTML = `Resend code (<span id="resend-timer">${RESEND_SECONDS}</span>s)`;
        const newTimerEl = document.getElementById('resend-timer');
        const tick2 = setInterval(() => {
          if (!document.getElementById('resend-btn')) { clearInterval(tick2); return; }
          remaining -= 1;
          if (remaining <= 0) {
            clearInterval(tick2);
            resendBtn.disabled = false;
            resendBtn.textContent = 'Resend code';
          } else if (newTimerEl) {
            newTimerEl.textContent = String(remaining);
          }
        }, 1000);
      } catch (err) {
        showError(err.message);
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend code';
      }
    });

    setTimeout(() => form.code.focus(), 50);
  }

  // -------------------------------------------------------------------
  // SHARED UI HELPERS
  // -------------------------------------------------------------------
  function showError(message) {
    const el = document.getElementById('auth-error');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
  }
  function hideError() {
    const el = document.getElementById('auth-error');
    if (!el) return;
    el.classList.remove('show');
  }
  function setLoading(btn, loading) {
    if (!btn) return;
    if (!btn.dataset.label) {
      const labelEl = btn.querySelector('.btn-label');
      btn.dataset.label = labelEl ? labelEl.textContent : btn.textContent;
    }
    btn.disabled = loading;
    btn.innerHTML = loading
      ? '<span class="spinner"></span>'
      : `<span class="btn-label">${UI.escapeHtml(btn.dataset.label)}</span>`;
  }

  return { renderSetup, renderSignup, renderLogin, renderForgotPassword };
})();