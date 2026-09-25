// =====================================================================
//  VAULT — shared modal / bottom-sheet (used by Borrowers, and later
//  Loans, Reminders, Settings)
// =====================================================================
'use strict';

const Modal = (() => {
  let backdropEl = null;

  function close() {
    if (!backdropEl) return;
    backdropEl.classList.remove('show');
    const el = backdropEl;
    setTimeout(() => el.remove(), 260);
    backdropEl = null;
    document.removeEventListener('keydown', onKeydown);
  }

  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  // opts: { title, bodyHtml, footHtml, onMount(bodyEl, footEl), dismissible }
  function open(opts) {
    close(); // only one at a time

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-sheet" role="dialog" aria-modal="true">
        <div class="modal-grabber"></div>
        <div class="modal-head">
          <h3>${opts.title || ''}</h3>
          <button class="icon-btn" data-close style="width:32px;height:32px;border-radius:10px;">${UI.icon('x', { size: 16 })}</button>
        </div>
        <div class="modal-body">${opts.bodyHtml || ''}</div>
        ${opts.footHtml ? `<div class="modal-foot">${opts.footHtml}</div>` : ''}
      </div>
    `;
    document.body.appendChild(backdrop);
    backdropEl = backdrop;

    if (opts.dismissible !== false) {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
      });
    }
    backdrop.querySelector('[data-close]').addEventListener('click', close);
    document.addEventListener('keydown', onKeydown);

    requestAnimationFrame(() => backdrop.classList.add('show'));

    const bodyEl = backdrop.querySelector('.modal-body');
    const footEl = backdrop.querySelector('.modal-foot');
    if (typeof opts.onMount === 'function') opts.onMount(bodyEl, footEl, close);

    return { close, bodyEl, footEl };
  }

  // Small helper for a yes/no confirmation, returns a Promise<boolean>.
  function confirm({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      let resolved = false;
      const { close: closeThis } = open({
        title,
        bodyHtml: `<p style="color:var(--text-muted);font-size:14px;line-height:1.5;">${message}</p>`,
        footHtml: `
          <button class="btn btn-ghost" data-cancel>Cancel</button>
          <button class="btn btn-primary" data-ok style="${danger ? 'background:linear-gradient(135deg,#FF6B6B,#FF9B9B);' : ''}">${confirmLabel}</button>
        `,
        onMount: (body, foot) => {
          foot.querySelector('[data-cancel]').addEventListener('click', () => { resolved = true; resolve(false); closeThis(); });
          foot.querySelector('[data-ok]').addEventListener('click', () => { resolved = true; resolve(true); closeThis(); });
        },
      });
      // if dismissed via backdrop/X/escape without a button press
      const check = setInterval(() => {
        if (!backdropEl) {
          clearInterval(check);
          if (!resolved) resolve(false);
        }
      }, 150);
    });
  }

  return { open, close, confirm };
})();