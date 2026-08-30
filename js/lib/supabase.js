// Minimal Supabase client over fetch(): GoTrue auth + PostgREST + RPC.
// Isolated session key so it never collides with the main platform app.
import { SUPABASE_URL, SUPABASE_ANON_KEY, SESSION_KEY } from '../../config.js?v=20260830b';

const AUTH = SUPABASE_URL + '/auth/v1';
const REST = SUPABASE_URL + '/rest/v1';

let session = null;
let onLogout = () => {};
export function setLogoutHandler(fn) { onLogout = fn; }
export function getSession() { return session; }
export function userId() { return session?.user?.id || null; }

function headers(json = true) {
  const h = { apikey: SUPABASE_ANON_KEY };
  if (session?.access_token) h.Authorization = 'Bearer ' + session.access_token;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function persist(p) {
  session = {
    access_token: p.access_token,
    refresh_token: p.refresh_token,
    expires_at: Date.now() + (p.expires_in || 3600) * 1000,
    user: p.user || session?.user || null,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
export function clearSession() { session = null; localStorage.removeItem(SESSION_KEY); }

async function authPost(path, body) {
  const res = await fetch(AUTH + path, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.msg || data.message || ('HTTP ' + res.status));
  return data;
}

export const auth = {
  async signIn(email, password) { const d = await authPost('/token?grant_type=password', { email, password }); persist(d); return d; },
  async signUp(email, password, meta = {}) {
    const d = await authPost('/signup', { email, password, data: meta });
    if (d.access_token) persist(d);
    return d;
  },
  async recover(email) { return authPost('/recover', { email }); },
  async updatePassword(password) {
    const res = await fetch(AUTH + '/user', { method: 'PUT', headers: headers(), body: JSON.stringify({ password }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error_description || d.msg || d.message || 'update failed');
    return d;
  },

  // Is `password` the CURRENT password of the signed-in user?
  //
  // GoTrue has no "check my password" endpoint, so we ask it for a token using
  // that password and throw the answer away. Deliberately NOT persisted: a
  // wrong guess must not disturb the live session, and a correct one must not
  // leave the app holding a second one. Returns true/false for a credential
  // verdict and rethrows anything else (offline, rate-limited, 500) so those
  // are never mistaken for "wrong password".
  async verifyPassword(password) {
    const email = session?.user?.email;
    if (!email) throw new Error('You are not signed in.');
    try {
      await authPost('/token?grant_type=password', { email, password });
      return true;
    } catch (e) {
      if (/invalid login|invalid grant|invalid_grant|credentials/i.test(e.message || '')) return false;
      throw e;
    }
  },

  // Change the signed-in user's own password.
  //
  // There is no "whose password" parameter and there never should be: the email
  // comes from the live session, so this cannot be pointed at another account.
  // Supabase Auth stores the hash; the app never sees, keeps or logs either
  // password, and no password is written to any table.
  async changePassword(currentPassword, newPassword) {
    const email = session?.user?.email;
    if (!email) throw new Error('You are not signed in.');

    if (!(await auth.verifyPassword(currentPassword))) {
      const e = new Error('Your current password is incorrect.');
      e.code = 'BAD_CURRENT';
      throw e;
    }

    await auth.updatePassword(newPassword);

    // Changing a password can invalidate the refresh token that was issued
    // before it. Sign in again with the NEW one so the user stays logged in on
    // a fully valid session instead of being bounced at the next silent
    // refresh. A failure here does not undo the change, which has already
    // happened — so it must not be reported as one.
    try { await auth.signIn(email, newPassword); } catch (_) {}
    return true;
  },
  async signOut() {
    try { await fetch(AUTH + '/logout', { method: 'POST', headers: headers(false) }); } catch (_) {}
    clearSession();
  },
  async restore() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return false;
      session = JSON.parse(raw);
      if (!session?.access_token) { clearSession(); return false; }
      if (!session.expires_at || session.expires_at - Date.now() < 60000) return refresh();
      return true;
    } catch (_) { clearSession(); return false; }
  },
};

async function refresh() {
  try {
    const d = await authPost('/token?grant_type=refresh_token', { refresh_token: session.refresh_token });
    if (!d.access_token) return false;
    persist(d); return true;
  } catch (_) { clearSession(); return false; }
}

async function request(url, opts = {}, retried = false) {
  const res = await fetch(url, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  if (res.ok) {
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  // Error path — read the body once and classify it.
  const err = await res.json().catch(() => ({}));
  const msg = err.message || err.msg || '';
  // Only an EXPIRED / INVALID JWT should trigger a token refresh (then logout).
  // PostgREST signals that with 401 + a JWT-related code/message.
  const jwtExpired = res.status === 401 &&
    (err.code === 'PGRST301' || err.code === 'PGRST302' || /jwt|token|expired/i.test(msg));
  if (jwtExpired && !retried && session?.refresh_token) {
    if (await refresh()) return request(url, opts, true);
    onLogout();
    throw new Error('Your session expired — please sign in again.');
  }
  // 42501 = Postgres "permission denied for table": a GRANTS problem, NOT an auth
  // problem. Surface it clearly instead of forcing a logout/refresh loop.
  if (err.code === '42501') {
    throw new Error('Permission denied by the database (missing grants for the "authenticated" role — run db/fix-grants.sql).');
  }
  throw new Error(msg || err.error || err.hint || ('HTTP ' + res.status));
}

// --- PostgREST ---
export const db = {
  list: (table, query = 'select=*') => request(`${REST}/${table}?${query}`),
  one: async (table, query) => { const r = await request(`${REST}/${table}?${query}`); return r?.[0] || null; },
  create: (table, row) => request(`${REST}/${table}`, {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row),
  }).then(r => Array.isArray(r) ? r[0] : r),
  update: (table, filter, row) => request(`${REST}/${table}?${filter}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row),
  }),
  upsert: (table, row, onConflict) => request(`${REST}/${table}?on_conflict=${onConflict}`, {
    method: 'POST', headers: { Prefer: 'return=representation,resolution=merge-duplicates' }, body: JSON.stringify(row),
  }),
  remove: (table, filter) => request(`${REST}/${table}?${filter}`, { method: 'DELETE' }),
  // Postgres function call
  rpc: (fn, args = {}) => request(`${REST}/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) }),
};
