import { el, icon } from './ui.js?v=20260813c';

let root;
function ensure() { return (root ||= document.getElementById('toast-root')); }

export function toast(msg, kind = '') {
  const t = el('div.toast' + (kind ? '.' + kind : ''));
  const ic = kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'info';
  t.innerHTML = `${icon(ic, 'ti')}<span></span>`;
  t.querySelector('span').textContent = msg;
  ensure().append(t);
  setTimeout(() => { t.style.transition = 'opacity .3s, transform .3s'; t.style.opacity = '0'; t.style.transform = 'translateY(8px)';
    setTimeout(() => t.remove(), 300); }, 2800);
  return t;
}
export const toastOk = (m) => toast(m, 'ok');
export const toastErr = (m) => toast(m, 'err');

// ---- Modal / confirm dialog -----------------------------------------------
export function modal({ title, body, actions }) {
  const mroot = document.getElementById('modal-root');
  const scrim = el('div.modal-scrim');
  const box = el('div.modal');
  box.append(el('div.grip'));
  if (title) box.append(el('h3', title));
  if (body) box.append(typeof body === 'string' ? el('p.small.muted', { style: { marginBottom: '18px' } }, body) : body);
  const close = () => { scrim.style.opacity = '0'; setTimeout(() => scrim.remove(), 180); };
  if (actions) {
    const bar = el('div.row', { style: { gap: '10px', marginTop: '20px' } });
    for (const a of actions) {
      const b = el('button.btn.grow' + (a.cls ? '.' + a.cls : ''), a.label);
      b.addEventListener('click', () => { if (a.onClick) a.onClick(close); else close(); });
      bar.append(b);
    }
    box.append(bar);
  }
  scrim.append(box);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  mroot.append(scrim);
  return { close };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm }) {
  return modal({
    title, body: message,
    actions: [
      { label: 'Cancel', cls: 'btn--pill-line' },
      { label: confirmLabel, cls: danger ? 'btn--danger' : 'btn--primary', onClick: (close) => { close(); onConfirm && onConfirm(); } },
    ],
  });
}
