// Domain data access — all ta_* tables. Thin wrappers over supabase db.
import { db, userId } from './supabase.js?v=20260820a';
import { todayYMD, ymd } from './time.js?v=20260820a';

// ---- Profiles -------------------------------------------------------------
export const Profiles = {
  me: () => db.one('ta_profiles', `id=eq.${userId()}&select=*`),
  all: () => db.list('ta_profiles', 'select=*&order=full_name.asc'),
  get: (id) => db.one('ta_profiles', `id=eq.${id}&select=*`),
  update: (id, patch) => db.update('ta_profiles', `id=eq.${id}`, patch),
};

// ---- Attendance -----------------------------------------------------------
// Clock in/out go through SECURITY DEFINER RPCs — employees have no direct
// INSERT/UPDATE on ta_attendance (see db/schema-v2.sql), so the geofence check
// cannot be skipped by crafting a PostgREST call.
export const Attendance = {
  today: (empId = userId()) => db.one('ta_attendance', `employee_id=eq.${empId}&work_date=eq.${todayYMD()}&select=*`),
  forMonth: (empId, y, m) => {
    const from = ymd(new Date(y, m, 1)), to = ymd(new Date(y, m + 1, 0));
    return db.list('ta_attendance', `employee_id=eq.${empId}&work_date=gte.${from}&work_date=lte.${to}&select=*&order=work_date.asc`);
  },
  range: (from, to) => db.list('ta_attendance', `work_date=gte.${from}&work_date=lte.${to}&select=*,ta_profiles(full_name,department,position,avatar_url)&order=clock_in.desc`),
  clockIn: async (pos) => unwrapClock(await db.rpc('ta_clock_in',
    { p_lat: pos.lat, p_lng: pos.lng, p_accuracy: pos.accuracy })),
  clockOut: async (pos) => unwrapClock(await db.rpc('ta_clock_out',
    { p_lat: pos.lat, p_lng: pos.lng, p_accuracy: pos.accuracy })),
};

// ta_clock_in / ta_clock_out answer with { ok, error, reason, distance_m,
// radius_m, record } instead of raising, so that the ta_geo_attempts row
// written for a BLOCKED attempt is not rolled back with the exception.
// Turn a refusal back into a throw for callers, carrying the server's reason.
function unwrapClock(res) {
  if (!res || typeof res !== 'object') throw new Error('Unexpected response from the server.');
  if (!res.ok) {
    const err = new Error(res.error || 'The server refused this action.');
    err.reason = res.reason;
    err.distance_m = res.distance_m;
    err.radius_m = res.radius_m;
    throw err;
  }
  const rec = res.record || {};
  rec.__distance_m = res.distance_m;
  rec.__radius_m = res.radius_m;
  return rec;
}

// ---- Leave balances -------------------------------------------------------
export const Balances = {
  mine: (empId = userId()) => db.list('ta_leave_balances', `employee_id=eq.${empId}&select=*&order=leave_type.asc`),
  all: () => db.list('ta_leave_balances', 'select=*,ta_profiles(full_name,department,avatar_url)'),
  update: (id, patch) => db.update('ta_leave_balances', `id=eq.${id}`, patch),
};

// ---- Leave requests -------------------------------------------------------
export const Leaves = {
  mine: (empId = userId()) => db.list('ta_leave_requests', `employee_id=eq.${empId}&select=*&order=created_at.desc`),
  // ta_leave_requests has TWO FKs to ta_profiles (employee_id + reviewed_by), so the
  // embed MUST name the FK. !employee_id = the requester's profile. Response key stays "ta_profiles".
  pending: () => db.list('ta_leave_requests', `status=eq.pending&select=*,ta_profiles!employee_id(full_name,department,avatar_url)&order=created_at.asc`),
  all: () => db.list('ta_leave_requests', `select=*,ta_profiles!employee_id(full_name,department,avatar_url)&order=created_at.desc`),
  create: (row) => db.create('ta_leave_requests', { ...row, employee_id: userId() }),
  review: (id, decision) => db.rpc('ta_review_leave', { p_request_id: id, p_decision: decision }),
};

// ---- Weekly off days ------------------------------------------------------
export const OffDays = {
  mine: (empId = userId()) => db.list('ta_weekly_off_days', `employee_id=eq.${empId}&select=day_of_week`),
  set: async (empId, days) => {
    await db.remove('ta_weekly_off_days', `employee_id=eq.${empId}`);
    if (days.length) await db.create('ta_weekly_off_days', days.map(d => ({ employee_id: empId, day_of_week: d })));
  },
};

// ---- Weekend change requests ---------------------------------------------
// Max 2 per employee. #1 is auto-approved and applied instantly; #2 needs an
// admin decision. Both limits are enforced in ta_request_weekend_change().
export const Weekend = {
  MAX: 2,
  mine: (empId = userId()) => db.list('ta_weekend_change_requests',
    `employee_id=eq.${empId}&select=*&order=change_number.asc`),
  all: () => db.list('ta_weekend_change_requests',
    `select=*,ta_profiles!employee_id(full_name,department,avatar_url)&order=requested_at.desc`),
  pending: () => db.list('ta_weekend_change_requests',
    `status=eq.pending&select=*,ta_profiles!employee_id(full_name,department,avatar_url)&order=requested_at.asc`),
  request: (days, reason) => db.rpc('ta_request_weekend_change', { p_days: days, p_reason: reason || null }),
  review: (id, decision, note) => db.rpc('ta_review_weekend_change',
    { p_request_id: id, p_decision: decision, p_note: note || null }),
  // Allowance consumed = every request that wasn't rejected by an admin.
  usedFrom: (rows) => (rows || []).filter(r => r.status !== 'rejected').length,
};

// ---- Rest days ------------------------------------------------------------
export const RestDays = {
  balance: (empId = userId()) => db.one('ta_rest_balances', `employee_id=eq.${empId}&select=*`),
  balances: () => db.list('ta_rest_balances', 'select=*,ta_profiles(full_name,department,avatar_url)'),
  mine: (empId = userId()) => db.list('ta_rest_day_requests', `employee_id=eq.${empId}&select=*&order=created_at.desc`),
  all: () => db.list('ta_rest_day_requests',
    `select=*,ta_profiles!employee_id(full_name,department,avatar_url)&order=created_at.desc`),
  pending: () => db.list('ta_rest_day_requests',
    `status=eq.pending&select=*,ta_profiles!employee_id(full_name,department,avatar_url)&order=created_at.asc`),
  request: (dates, reason) => db.rpc('ta_request_rest_days', { p_dates: dates, p_reason: reason || null }),
  review: (id, decision, note) => db.rpc('ta_review_rest_days',
    { p_request_id: id, p_decision: decision, p_note: note || null }),
  setTotal: (empId, total) => db.rpc('ta_set_rest_balance', { p_employee: empId, p_total: total }),
  // Days already reserved by pending requests — they don't count as available.
  pendingDays: (rows) => (rows || []).filter(r => r.status === 'pending').reduce((s, r) => s + r.days_count, 0),
};

// ---- Settings (geofence config) ------------------------------------------
export const Settings = {
  get: () => db.one('ta_settings', 'id=eq.true&select=*'),
  setGeofence: ({ radius, lat = null, lng = null, enabled = null, maxAccuracy = null }) =>
    db.rpc('ta_set_geofence', {
      p_radius: radius, p_lat: lat, p_lng: lng, p_enabled: enabled, p_max_accuracy: maxAccuracy,
    }),
};

// ---- Geofence attempt log -------------------------------------------------
export const GeoLog = {
  recent: (limit = 100) => db.list('ta_geo_attempts',
    `select=*,ta_profiles(full_name,department,avatar_url)&order=created_at.desc&limit=${limit}`),
  forEmployee: (empId, limit = 50) => db.list('ta_geo_attempts',
    `employee_id=eq.${empId}&select=*&order=created_at.desc&limit=${limit}`),
};

// ---- Notifications --------------------------------------------------------
export const Notifs = {
  mine: (empId = userId()) => db.list('ta_notifications', `employee_id=eq.${empId}&select=*&order=created_at.desc&limit=50`),
  unread: (empId = userId()) => db.list('ta_notifications', `employee_id=eq.${empId}&is_read=eq.false&select=id`),
  markRead: (id) => db.update('ta_notifications', `id=eq.${id}`, { is_read: true }),
  markAllRead: (empId = userId()) => db.update('ta_notifications', `employee_id=eq.${empId}&is_read=eq.false`, { is_read: true }),
};
