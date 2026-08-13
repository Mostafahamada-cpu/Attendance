// ─────────────────────────────────────────────────────────────────────────────
//  RingRoad Attendance — runtime config.
//
//  Points at the SAME Supabase project as the main RingRoad app. The Attendance
//  app's tables are all namespaced `ta_*`, so it shares the project safely
//  without touching any existing RingRoad table, policy, or row.
//
//  Only the PUBLIC anon/publishable key lives here — it is meant to be exposed
//  to the browser and is protected by Row Level Security. NEVER put the
//  service_role key in this file.
//
//  This file is committed (see .gitignore) so it deploys to Vercel/Netlify with
//  no build step and no "/config.js 404". If you ever want to override the
//  values per-environment without editing this file, define window.__SUPABASE__
//  before the app loads, e.g. in index.html:
//     <script>window.__SUPABASE__ = { url: '…', anonKey: '…' }</script>
// ─────────────────────────────────────────────────────────────────────────────
const RUNTIME = (typeof window !== 'undefined' && window.__SUPABASE__) || {};

// Same project as the RingRoad platform (MD/platform/js/config.js).
export const SUPABASE_URL      = RUNTIME.url     || 'https://cbjguowbrbxrthokbmpd.supabase.co';
export const SUPABASE_ANON_KEY = RUNTIME.anonKey || 'sb_publishable_H_FVSTN6WJ86vqo9tcPV1Q_pSXRdF68';

// Distinct session key so the two apps never share/clobber auth state in the
// same browser.
export const SESSION_KEY = RUNTIME.sessionKey || 'rr_attendance_session';

// Live-view polling interval (ms) — admin "Who's In", employee unread badge.
export const POLL_MS = RUNTIME.pollMs || 20000;
