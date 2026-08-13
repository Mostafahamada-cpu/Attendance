// DOM helpers, SVG icons, avatars, rings, toasts, modals.

// Hyperscript: el('div.card#id', {onClick}, child, child) OR el('div', 'text')
export function el(sel, props, ...kids) {
  const [tag, ...rest] = sel.split(/(?=[.#])/);
  const node = document.createElement(tag || 'div');
  for (const token of rest) {
    if (token[0] === '.') node.classList.add(token.slice(1));
    else if (token[0] === '#') node.id = token.slice(1);
  }
  if (props && (typeof props !== 'object' || props.nodeType || Array.isArray(props))) { kids.unshift(props); props = null; }
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className += ' ' + v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export function mount(root, node) { root.replaceChildren(node); }
export function clear(node) { node.replaceChildren(); }

// ---- Icons (stroke-based, currentColor) ------------------------------------
const P = { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12Z"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/>',
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  grid: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
  fingerprint: '<path d="M12 4a8 8 0 0 0-8 8v3"/><path d="M12 4a8 8 0 0 1 8 8v1"/><path d="M8 12a4 4 0 0 1 8 0v3a9 9 0 0 1-.5 3"/><path d="M12 12v4a10 10 0 0 0 .8 4"/><path d="M6.5 18.5A9 9 0 0 0 8 20"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  login: '<path d="M15 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>',
  logout: '<path d="M9 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0"/><path d="M16 5a3.5 3.5 0 0 1 0 7M22 20a6.5 6.5 0 0 0-5-6.3"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18"/>',
  check: '<path d="M5 12.5 10 17l9-10"/>',
  checkcircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5 11 15.5 16 9"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  xcircle: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  chevL: '<path d="M15 18 9 12l6-6"/>',
  chevR: '<path d="M9 6l6 6-6 6"/>',
  chevD: '<path d="M6 9l6 6 6-6"/>',
  arrowL: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M4 7l8 6 8-6"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.5 6.2A9.8 9.8 0 0 1 12 6c6.5 0 10 6 10 6a15 15 0 0 1-3 3.6M6 7.5A15 15 0 0 0 2 12s3.5 6 10 6a9.7 9.7 0 0 0 4-.9"/><path d="M9.5 10.5a3 3 0 0 0 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4Z"/>',
  alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 9v5M12 17.5v.1"/>',
  coffee: '<path d="M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z"/><path d="M17 9h2a2.5 2.5 0 0 1 0 5h-2M6 2v2M10 2v2M14 2v2"/>',
  calplus: '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9h18M8 2.5v4M16 2.5v4M12 13v4M10 15h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 14a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.6 2 2 0 1 1 14 3.6a1.6 1.6 0 0 0 2.7-1.1l.1.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .8-1 1.7M12 17v.1"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  google: '<path d="M21 12.2c0-.6-.05-1.2-.15-1.8H12v3.5h5.05a4.3 4.3 0 0 1-1.87 2.8v2.3h3.02C19.96 17.3 21 15 21 12.2Z" fill="#4285F4" stroke="none"/><path d="M12 21c2.5 0 4.6-.83 6.15-2.25l-3.02-2.3c-.83.56-1.9.9-3.13.9-2.4 0-4.44-1.62-5.17-3.8H3.7v2.38A9 9 0 0 0 12 21Z" fill="#34A853" stroke="none"/><path d="M6.83 13.55a5.4 5.4 0 0 1 0-3.1V8.07H3.7a9 9 0 0 0 0 7.86Z" fill="#FBBC05" stroke="none"/><path d="M12 6.9c1.36 0 2.57.47 3.53 1.38l2.65-2.65A9 9 0 0 0 3.7 8.07l3.13 2.38C7.56 8.52 9.6 6.9 12 6.9Z" fill="#EA4335" stroke="none"/>',
  edit: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17Z"/><path d="M13.5 6.5l3 3"/>',
  trash: '<path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  moon: '<path d="M21 12.8A8 8 0 1 1 11.2 3 6 6 0 0 0 21 12.8Z"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  reminder: '<path d="M12 3a6 6 0 0 0-6 6c0 5-2 6-2 6h16s-2-1-2-6a6 6 0 0 0-6-6Z"/><path d="M10 20a2 2 0 0 0 4 0M12 3V1.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.1"/>',
};
export function icon(name, cls = '') {
  const body = ICONS[name] || ICONS.info;
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
// icon as a real element
export function iconEl(name, cls = '') { const s = el('span'); s.innerHTML = icon(name, cls); return s.firstChild; }

// ---- Avatar ---------------------------------------------------------------
export function avatar(profile, size = '') {
  const name = profile?.full_name || profile?.email || '?';
  const initials = name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const a = el('div.avatar' + (size ? '.avatar--' + size : ''));
  if (profile?.avatar_url) a.append(el('img', { src: profile.avatar_url, alt: name }));
  else a.textContent = initials || '?';
  a.style.background = colorFor(name);
  return a;
}
export function colorFor(str) {
  const grads = ['linear-gradient(135deg,#2BC3BC,#2F80ED)', 'linear-gradient(135deg,#7F7FD5,#86A8E7)',
    'linear-gradient(135deg,#F6997A,#EE5A8F)', 'linear-gradient(135deg,#43C6AC,#4C83B6)',
    'linear-gradient(135deg,#F7A072,#E8A33D)', 'linear-gradient(135deg,#5FBF9F,#2BC3BC)'];
  let h = 0; for (const c of str || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return grads[h % grads.length];
}

// ---- Ring / donut ---------------------------------------------------------
// value/max drive the arc. size px. color css var value.
export function ring({ value, max, size = 88, stroke = 9, color = 'var(--teal)', label, sub, track = 'var(--surface-2)' }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  const wrap = el('div.ring', { style: { width: size + 'px', height: size + 'px' } });
  wrap.innerHTML = `<svg width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"
        style="transition:stroke-dashoffset .7s cubic-bezier(.22,.61,.36,1)"/>
    </svg>
    <div class="ring-c"><div class="rv">${label ?? value}</div>${sub ? `<div class="rk">${sub}</div>` : ''}</div>`;
  return wrap;
}

// ---- Page header with back button -----------------------------------------
export function pageHead(title, onBack, right) {
  const h = el('div.row', { style: { gap: '12px', marginBottom: '18px' } });
  const b = el('button', { 'aria-label': 'Back',
    style: { width: '40px', height: '40px', borderRadius: '50%', background: 'var(--surface-2)', display: 'grid', placeContent: 'center', flex: 'none' },
    html: icon('arrowL') });
  b.addEventListener('click', onBack || (() => history.back()));
  h.append(b, el('h2.grow', { style: { fontSize: '19px', fontWeight: '800' } }, title));
  if (right) h.append(right);
  return h;
}

// ---- Empty state ----------------------------------------------------------
export function emptyState(iconName, title, sub) {
  const e = el('div.empty');
  e.innerHTML = `<div class="ei">${icon(iconName)}</div><h4>${title}</h4>` + (sub ? `<p class="small">${sub}</p>` : '');
  return e;
}

// ---- Pills ----------------------------------------------------------------
export function pill(status) {
  const map = { approved: 'Approved', pending: 'Pending', denied: 'Denied', present: 'Present',
    working: 'Working', absent: 'Absent', weekend: 'Weekend', completed: 'Completed' };
  const cls = status === 'completed' ? 'approved' : status;
  return el('span.pill.pill--' + cls, map[status] || status);
}
