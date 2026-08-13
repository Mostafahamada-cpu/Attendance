// ─────────────────────────────────────────────────────────────────────────────
//  RingRoad Attendance — configuration TEMPLATE.
//  Copy this file to `config.js` and fill in your Supabase project values.
//  `config.js` is git-ignored so real credentials are never committed.
//
//  The anon/publishable key is safe to ship to the browser (it is protected by
//  Row Level Security) — but keeping it out of git keeps the repo clean and
//  lets each deploy target its own project.
//
//  Find these in: Supabase Dashboard → Project Settings → API
// ─────────────────────────────────────────────────────────────────────────────
export const SUPABASE_URL      = 'https://YOUR-PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-OR-PUBLISHABLE-KEY';

// Session storage key (kept distinct from the main platform so the two apps
// never share or clobber each other's auth session in the same browser).
export const SESSION_KEY = 'rr_attendance_session';

// How often (ms) live views poll for changes (admin "Who's In", notifications).
export const POLL_MS = 20000;
