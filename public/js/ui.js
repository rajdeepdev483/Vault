// =====================================================================
//  VAULT — small shared UI helpers
// =====================================================================
'use strict';

const UI = (() => {
  let currencySymbol = 'Rs';

  // A small, self-contained line-icon set (no external font/CDN — keeps the
  // strict same-origin CSP happy and works offline). Every icon is a 24x24
  // stroke path using currentColor, so it always matches surrounding text.
  const ICONS = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 20c.2-2.4 1.7-3.8 4-4"/>',
    list: '<path d="M9 6h12"/><path d="M9 12h12"/><path d="M9 18h12"/><circle cx="4" cy="6" r="1.3"/><circle cx="4" cy="12" r="1.3"/><circle cx="4" cy="18" r="1.3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H8a1.7 1.7 0 0 0 1-1.6V2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V8a1.7 1.7 0 0 0 1.6 1H22a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1Z"/>',
    power: '<path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
    bell: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10.5 20a1.7 1.7 0 0 0 3 0"/>',
    theme: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
    alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M3.5 10h17"/><path d="M8 3v4M16 3v4"/>',
    inbox: '<path d="M4 12h4l1.5 2.5h5L16 12h4"/><path d="M5 12 4 5h16l-1 7"/><path d="M5 12v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6"/>',
    'arrow-up-right': '<path d="M7 17 17 7"/><path d="M9 7h8v8"/>',
    'arrow-down-left': '<path d="M17 7 7 17"/><path d="M15 17H7V9"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'chevron-left': '<path d="m15 6-6 6 6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    phone: '<path d="M6.5 4h3l1.5 4-2 1.5a11 11 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4Z"/>',
    edit: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m13.5 6.5 3 3"/>',
    archive: '<rect x="3.5" y="4" width="17" height="4.5" rx="1"/><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5"/><path d="M10 13h4"/>',
    undo: '<path d="M4 10h9a5 5 0 0 1 0 10h-1"/><path d="m8 5-4 5 4 5"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
    unlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 7.5-2"/>',
    'more-vertical': '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.5 5.5 13 13"/>',
    'rotate-cw': '<path d="M20 11a8 8 0 1 0-2.3 6.4"/><path d="M20 5v6h-6"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M3 3l18 18"/><path d="M10.6 5.2A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a15.5 15.5 0 0 1-3.4 4.4M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  };

  function icon(name, { size = 20, strokeWidth = 1.8 } = {}) {
    const body = ICONS[name];
    if (!body) return '';
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:inline-block;vertical-align:middle;">${body}</svg>`;
  }

  function setCurrencySymbol(sym) {
    currencySymbol = sym || 'Rs';
  }

  // Indian-style grouping (e.g. 1,23,456), no decimals for whole rupees.
  function formatMoney(amount, { withSymbol = true, decimals } = {}) {
    if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return withSymbol ? `${currencySymbol} —` : '—';
    const n = Number(amount);
    const useDecimals = decimals !== undefined ? decimals : (Math.abs(n % 1) > 0.001 ? 2 : 0);
    const formatted = n.toLocaleString('en-IN', {
      minimumFractionDigits: useDecimals,
      maximumFractionDigits: useDecimals,
    });
    return withSymbol ? `${currencySymbol} ${formatted}` : formatted;
  }

  function initials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  function formatDateShort(dateStr) {
    if (!dateStr) return '—';
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  function greetingForHour() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Animated count-up for the big stat numbers. Respects reduced-motion.
  function countUp(el, toValue, { prefix = '', decimals = 0, duration = 900 } = {}) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !Number.isFinite(toValue)) {
      el.textContent = `${prefix}${formatMoney(toValue, { withSymbol: false, decimals })}`;
      return;
    }
    const start = performance.now();
    const from = 0;
    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out-cubic
      const val = from + (toValue - from) * eased;
      el.textContent = `${prefix}${formatMoney(val, { withSymbol: false, decimals })}`;
      if (t < 1) requestAnimationFrame(frame);
      else el.textContent = `${prefix}${formatMoney(toValue, { withSymbol: false, decimals })}`;
    }
    requestAnimationFrame(frame);
  }

  let toastTimer = null;
  function toast(message) {
    let el = document.getElementById('vault-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'vault-toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // -------------------------------------------------------------------
  // CLICK-TO-EDIT FIELD
  // Turns `el` into a self-contained inline editor: shows the current
  // value, and on click swaps in a text/textarea/select input. Commits
  // on blur / Enter, cancels on Escape. `onSave` should return a promise
  // and throw (or reject) with a `.message` to trigger a revert + toast.
  // -------------------------------------------------------------------
  function editableField(el, {
    value = '',
    type = 'text',            // text | textarea | number | date | select
    options = [],             // [{ value, label }] — for type:'select'
    placeholder = '',
    emptyText = 'Not provided',
    maxLength,
    min,
    required = false,
    label = 'This field',
    block = false,
    format,                   // (value) => displayString
    onSave,                   // async (newValue) => void
  } = {}) {
    if (block) el.classList.add('editable-block');
    el.classList.add('editable-field');
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `Edit ${label}`);

    function renderView() {
      el.classList.remove('editing');
      const shown = value ? (format ? format(value) : value) : '';
      el.innerHTML = `
        <span class="ef-display${value ? '' : ' empty'}">${escapeHtml(shown || placeholder || emptyText)}</span>
        <span class="ef-pencil">${icon('edit', { size: 11, strokeWidth: 2 })}</span>
      `;
    }

    function enterEdit(e) {
      if (e) e.stopPropagation();
      if (el.classList.contains('editing')) return;
      el.classList.add('editing');
      el.innerHTML = '';

      let input;
      if (type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
        input.value = value || '';
      } else if (type === 'select') {
        input = document.createElement('select');
        options.forEach((o) => {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          if (String(o.value) === String(value ?? '')) opt.selected = true;
          input.appendChild(opt);
        });
      } else {
        input = document.createElement('input');
        input.type = type === 'number' ? 'number' : type === 'date' ? 'date' : 'text';
        input.value = value ?? '';
        if (type === 'number') input.step = 'any';
      }
      input.className = 'ef-input';
      if (maxLength) input.maxLength = maxLength;
      if (min !== undefined) input.min = min;
      if (placeholder) input.placeholder = placeholder;
      el.appendChild(input);
      input.focus();
      if (input.select) input.select();

      let settled = false;

      async function commit() {
        if (settled) return;
        const raw = 'value' in input ? input.value : '';
        const newVal = typeof raw === 'string' ? raw.trim() : raw;
        if (required && !newVal) {
          toast(`${label} is required`);
          input.focus();
          return; // stay in edit mode so nothing is lost
        }
        if (newVal === (value ?? '')) { settled = true; renderView(); return; }
        settled = true;
        el.classList.add('saving');
        try {
          await onSave(newVal);
          value = newVal;
          renderView();
          el.classList.add('ef-flash');
          setTimeout(() => el.classList.remove('ef-flash'), 700);
        } catch (err) {
          toast((err && err.message) || 'Could not save — try again');
          renderView();
        } finally {
          el.classList.remove('saving');
        }
      }

      function cancel() {
        if (settled) return;
        settled = true;
        renderView();
      }

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
        else if (ev.key === 'Enter' && type !== 'textarea') { ev.preventDefault(); input.blur(); }
        else if (ev.key === 'Enter' && type === 'textarea' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); input.blur(); }
      });
      if (type === 'select') input.addEventListener('change', () => input.blur());
    }

    el.addEventListener('click', enterEdit);
    el.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !el.classList.contains('editing')) {
        e.preventDefault();
        enterEdit();
      }
    });

    renderView();

    return {
      setValue(v) { value = v; if (!el.classList.contains('editing')) renderView(); },
      getValue() { return value; },
    };
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'dark' || theme === 'light') {
      root.setAttribute('data-theme', theme);
    } else {
      root.removeAttribute('data-theme'); // 'system' — let the media query decide
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(root).getPropertyValue('--bg').trim() || '#0B0F14';
      meta.setAttribute('content', bg);
    }
  }

  // Wraps every password <input> inside `container` with a show/hide eye
  // button. Call this once, right after the form's HTML is in the DOM.
  function attachPasswordToggles(container) {
    (container || document).querySelectorAll('input[type="password"]').forEach((input) => {
      if (input.dataset.toggleWrapped) return;
      input.dataset.toggleWrapped = '1';
      const wrap = document.createElement('div');
      wrap.className = 'pw-toggle-wrap';
      wrap.style.cssText = 'position:relative;';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      input.style.paddingRight = '40px';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Show password');
      btn.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;padding:6px;cursor:pointer;color:var(--text-muted);display:flex;';
      btn.innerHTML = icon('eye', { size: 18 });
      btn.addEventListener('click', () => {
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
        btn.innerHTML = icon(showing ? 'eye' : 'eye-off', { size: 18 });
      });
      wrap.appendChild(btn);
    });
  }

  // Quick, non-blocking password strength read-out — never used to reject
  // a password, only to nudge toward a stronger one. Returns {score 0-4, label}.
  function passwordStrength(pw) {
    if (!pw) return { score: 0, label: '' };
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    const common = ['password', '12345678', 'qwerty123', 'letmein', 'admin123'];
    if (common.includes(pw.toLowerCase())) score = 0;
    const capped = Math.min(score, 4);
    const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
    return { score: capped, label: labels[capped] };
  }

  // Attaches a live strength meter under a password <input>. Call after
  // attachPasswordToggles so the meter sits below the wrapped input.
  function attachStrengthMeter(input) {
    const meter = document.createElement('div');
    meter.className = 'pw-strength';
    meter.style.cssText = 'margin-top:6px;font-size:12px;color:var(--text-muted);display:none;';
    meter.innerHTML = `
      <div style="display:flex;gap:4px;margin-bottom:3px;">
        ${[0, 1, 2, 3].map((i) => `<span class="pw-bar" data-i="${i}" style="height:4px;flex:1;border-radius:2px;background:var(--border);"></span>`).join('')}
      </div>
      <span class="pw-label"></span>
    `;
    input.parentNode.parentNode.insertBefore(meter, input.parentNode.nextSibling);
    const colors = ['#e5484d', '#f5a623', '#f5a623', '#3dd598', '#3dd598'];
    input.addEventListener('input', () => {
      const { score, label } = passwordStrength(input.value);
      meter.style.display = input.value ? 'block' : 'none';
      meter.querySelectorAll('.pw-bar').forEach((bar, i) => {
        bar.style.background = i < score ? colors[score] : 'var(--border)';
      });
      meter.querySelector('.pw-label').textContent = label;
    });
  }

  return {
    setCurrencySymbol,
    formatMoney,
    initials,
    formatDate,
    formatDateShort,
    greetingForHour,
    escapeHtml,
    countUp,
    toast,
    applyTheme,
    icon,
    editableField,
    attachPasswordToggles,
    passwordStrength,
    attachStrengthMeter,
  };
})();