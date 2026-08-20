// RingRoad Attendance — entry point: session, routing, app shells.
import { auth, getSession, setLogoutHandler } from './lib/supabase.js?v=20260820a';
import { Profiles, Notifs } from './lib/data.js?v=20260820a';
import { el, icon, avatar, mount } from './lib/ui.js?v=20260820a';
import { toastErr } from './lib/toast.js?v=20260820a';
import { SUPABASE_URL } from '../config.js?v=20260820a';

import loginPage from './pages/login.js?v=20260820a';
import empHome from './pages/employee/home.js?v=20260820a';
import empApply from './pages/employee/apply-leave.js?v=20260820a';
import empLeaves from './pages/employee/my-leaves.js?v=20260820a';
import empCalendar from './pages/employee/calendar.js?v=20260820a';
import empNotifs from './pages/employee/notifications.js?v=20260820a';
import empChat from './pages/employee/chat.js?v=20260820a';
import empMore from './pages/employee/more.js?v=20260820a';
import empWeekend from './pages/employee/weekend.js?v=20260820a';
import empRest from './pages/employee/rest-days.js?v=20260820a';
import admDashboard from './pages/admin/dashboard.js?v=20260820a';
import admLeaves from './pages/admin/leaves.js?v=20260820a';
import admEmployees from './pages/admin/employees.js?v=20260820a';
import admBalances from './pages/admin/balances.js?v=20260820a';
import admOffdays from './pages/admin/offdays.js?v=20260820a';
import admAnalytics from './pages/admin/analytics.js?v=20260820a';
import admWeekend from './pages/admin/weekend.js?v=20260820a';
import admRest from './pages/admin/rest-days.js?v=20260820a';
import admGeofence from './pages/admin/geofence.js?v=20260820a';

const appRoot = document.getElementById('app');
export const state = { profile: null, unread: 0 };

// ---- Route tables ---------------------------------------------------------
const EMP_ROUTES = {
  home: empHome, apply: empApply, leaves: empLeaves, attendance: empCalendar,
  notifications: empNotifs, chat: empChat, more: empMore,
  weekend: empWeekend, 'rest-days': empRest,
};
const ADM_ROUTES = {
  admin: admDashboard, 'admin/leaves': admLeaves, 'admin/employees': admEmployees,
  'admin/balances': admBalances, 'admin/offdays': admOffdays, 'admin/analytics': admAnalytics,
  'admin/weekend': admWeekend, 'admin/rest-days': admRest, 'admin/geofence': admGeofence,
};

export function navigate(hash) { location.hash = hash; }

const EMP_NAV = [
  { r: 'home', icon: 'home', label: 'Home' },
  { r: 'chat', icon: 'chat', label: 'Chat' },
  { r: 'attendance', icon: 'calendar', label: 'Attendance' },
  { r: 'notifications', icon: 'bell', label: 'Alerts', badge: true },
  { r: 'more', icon: 'more', label: 'More' },
];
const ADM_NAV = [
  { r: 'admin', icon: 'grid', label: 'Dashboard' },
  { r: 'admin/leaves', icon: 'calplus', label: 'Leave Requests' },
  { r: 'admin/employees', icon: 'users', label: 'Employees' },
  { r: 'admin/balances', icon: 'briefcase', label: 'Leave Balances' },
  { r: 'admin/offdays', icon: 'calendar', label: 'Off-Days' },
  { r: 'admin/weekend', icon: 'swap', label: 'Weekend Changes' },
  { r: 'admin/rest-days', icon: 'moon', label: 'Rest Days' },
  { r: 'admin/geofence', icon: 'pin', label: 'Geofence' },
  { r: 'admin/analytics', icon: 'trend', label: 'Analytics' },
];

// ---- Employee shell -------------------------------------------------------
function empShell(routeKey) {
  const content = el('div#route');
  const nav = el('nav.botnav');
  for (const item of EMP_NAV) {
    const a = el('a' + (routeKey === item.r ? '.on' : ''), { href: '#/' + item.r });
    a.innerHTML = icon(item.icon, 'ic') + `<span>${item.label}</span>`;
    if (item.badge && state.unread > 0) {
      a.append(el('span.badge-dot', String(state.unread > 9 ? '9+' : state.unread)));
    }
    nav.append(a);
  }
  const wrap = el('div.app-emp');
  wrap.append(content, nav);
  mount(appRoot, wrap);
  return content;
}

// ---- Admin shell ----------------------------------------------------------
function admShell(routeKey) {
  const content = el('div#route');
  const side = el('aside.sidebar');
  const brand = el('div.brand');
  brand.innerHTML = `<div class="mk"></div><div><b>RingRoad</b><span>Attendance Admin</span></div>`;
  side.append(brand);
  for (const item of ADM_NAV) {
    const a = el('a.side-link' + (routeKey === item.r ? '.on' : ''), { href: '#/' + item.r });
    a.innerHTML = icon(item.icon, 'ic') + `<span class="t">${item.label}</span>`;
    side.append(a);
  }
  const foot = el('div.side-foot');
  const prof = el('div.side-link', { style: { cursor: 'default' } });
  prof.append(avatar(state.profile, 'sm'));
  prof.append(el('div', el('div.small.b', state.profile?.full_name || 'Admin'), el('div.tiny.muted', 'Administrator')));
  const out = el('a.side-link', { href: '#/logout', html: icon('logout', 'ic') + '<span class="t">Logout</span>' });
  foot.append(prof, out);
  side.append(foot);

  const main = el('main.admin-main');
  main.append(content);
  const wrap = el('div.app-admin');
  wrap.append(side, main);
  mount(appRoot, wrap);
  return content;
}

// ---- Skeleton while a page loads ------------------------------------------
function skeleton(container) {
  const s = el('div.screen');
  for (let i = 0; i < 3; i++) s.append(el('div.sk.sk-card', { style: { marginBottom: '14px' } }));
  container.append(s);
}

// ---- Render current route -------------------------------------------------
let currentToken = 0;
async function render() {
  const raw = (location.hash || '#/home').replace(/^#\/?/, '');
  const key = raw.split('?')[0] || 'home';

  if (key === 'logout') { await doLogout(); return; }

  const isAdmin = state.profile?.role === 'admin';
  // Route guard: admins land on admin, employees can't see admin.
  if (isAdmin && !key.startsWith('admin')) { navigate('#/admin'); return; }
  if (!isAdmin && key.startsWith('admin')) { navigate('#/home'); return; }

  const table = isAdmin ? ADM_ROUTES : EMP_ROUTES;
  const page = table[key] || table[isAdmin ? 'admin' : 'home'];
  const container = isAdmin ? admShell(key) : empShell(key);

  const token = ++currentToken;
  skeleton(container);
  try {
    const node = await page({ profile: state.profile, navigate, refresh: render });
    if (token !== currentToken) return; // a newer navigation superseded us
    container.replaceChildren(node);
    window.scrollTo(0, 0);
  } catch (e) {
    if (token !== currentToken) return;
    container.replaceChildren(errorState(e));
  }
}

function errorState(e) {
  const s = el('div.screen');
  const c = el('div.card.center-text', { style: { padding: '34px' } });
  c.innerHTML = `<div class="empty"><div class="ei">${icon('alert')}</div>
    <h4>Something went wrong</h4><p class="small">${(e?.message || e || 'Unknown error')}</p></div>`;
  const retry = el('button.btn.btn--primary', 'Retry');
  retry.addEventListener('click', render);
  c.append(retry);
  s.append(c);
  return s;
}

async function doLogout() {
  await auth.signOut();
  state.profile = null;
  location.hash = '';
  showLogin();
}

// ---- Login flow -----------------------------------------------------------
function showLogin() {
  mount(appRoot, loginPage({ onAuthed: boot }));
}

// ---- Poll unread notifications (lightweight "realtime") -------------------
let pollTimer;
async function pollUnread() {
  if (!state.profile || state.profile.role === 'admin') return;
  try { const r = await Notifs.unread(); state.unread = r?.length || 0; updateNavBadge(); } catch (_) {}
}
function updateNavBadge() {
  const nav = document.querySelector('.botnav');
  if (!nav) return;
  const bell = nav.querySelector('a[href="#/notifications"]');
  if (!bell) return;
  bell.querySelector('.badge-dot')?.remove();
  if (state.unread > 0) bell.append(el('span.badge-dot', state.unread > 9 ? '9+' : String(state.unread)));
}

// ---- Boot -----------------------------------------------------------------
async function boot() {
  try {
    state.profile = await Profiles.me();
  } catch (e) {
    // Profile row missing (schema not run, or trigger didn't fire) — surface clearly.
    state.profile = null;
  }
  if (!state.profile) {
    mount(appRoot, noProfileState());
    return;
  }
  if (!location.hash || location.hash === '#/' || location.hash === '#/logout') {
    location.hash = state.profile.role === 'admin' ? '#/admin' : '#/home';
  }
  await render();
  clearInterval(pollTimer);
  pollTimer = setInterval(pollUnread, 20000);
  pollUnread();
}

function noProfileState() {
  const s = el('div.auth');
  const c = el('div.auth-card.center-text');
  c.innerHTML = `<div class="auth-logo">${icon('shield')}</div>
    <h1>Almost there</h1>
    <p class="sub">Your account has no attendance profile yet. This usually means the database schema
    (<code>db/schema.sql</code>) hasn't been run on this Supabase project, or the profile trigger didn't fire.</p>
    <p class="small muted">Project: ${SUPABASE_URL.replace('https://', '')}</p>`;
  const retry = el('button.btn.btn--primary.btn--block', { style: { marginTop: '18px' } }, 'Retry');
  retry.addEventListener('click', async () => {
    retry.disabled = true; retry.textContent = 'Checking…';
    await boot();
  });
  const out = el('button.btn.btn--pill-line.btn--block', { style: { marginTop: '10px' } }, 'Sign out');
  out.addEventListener('click', doLogout);
  c.append(retry, out);
  s.append(c);
  return s;
}

// ---- Start ----------------------------------------------------------------
setLogoutHandler(() => { state.profile = null; showLogin(); });
window.addEventListener('hashchange', () => { if (state.profile) render(); });

(async function start() {
  const ok = await auth.restore();
  if (ok && getSession()) await boot();
  else showLogin();
})();
