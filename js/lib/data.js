// Domain data access — all ta_* tables. Thin wrappers over supabase db.
import { db, userId } from './supabase.js?v=20260903a';
import { todayYMD, ymd } from './time.js?v=20260903a';

// ---- Profiles -------------------------------------------------------------
export const Profiles = {
  me: () => db.one('ta_profiles', `id=eq.${userId()}&select=*`),
  all: () => db.list('ta_profiles', 'select=*&order=full_name.asc'),
  get: (id) => db.one('ta_profiles', `id=eq.${id}&select=*`),
  update: (id, patch) => db.update('ta_profiles', `id=eq.${id}`, patch),
  // Manager rights are privileged: a DB trigger rejects any non-admin trying to
  // change role/is_manager, so this must go through the RPC.
  setManager: (id, on) => db.rpc('ta_set_manager', { p_employee: id, p_is_manager: !!on }),
  managers: () => db.list('ta_profiles', 'is_manager=is.true&select=*&order=full_name.asc'),
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
// Read-only over PostgREST for EVERYONE, admins included (db/schema-v4.sql):
// the table has no INSERT/UPDATE policy and the grants are revoked. An admin
// changes an allowance through ta_set_leave_balance(s), which re-checks that
// the new total is not below the days already used, records who changed what
// in ta_balance_adjustments, and notifies the employee. `used_days` is never
// writable by hand — only ta_review_leave() moves it, on final approval.
export const Balances = {
  mine: (empId = userId()) => db.list('ta_leave_balances', `employee_id=eq.${empId}&select=*&order=leave_type.asc`),
  all: () => db.list('ta_leave_balances', 'select=*,ta_profiles(full_name,department,avatar_url)'),
  forEmployee: (empId) => db.list('ta_leave_balances', `employee_id=eq.${empId}&select=*&order=leave_type.asc`),
  // One leave type.
  setTotal: (empId, leaveType, total, note) => db.rpc('ta_set_leave_balance',
    { p_employee: empId, p_leave_type: leaveType, p_total: total, p_note: note || null }),
  // All three at once, atomically — pass null for a type to leave it untouched.
  // Returns the employee's stored balances, so the caller can render the
  // authoritative figures instead of the ones it just sent.
  setAll: (empId, { casual = null, medical = null, planned = null }, note) => db.rpc('ta_set_leave_balances',
    { p_employee: empId, p_casual: casual, p_medical: medical, p_planned: planned, p_note: note || null }),
};

// ---- Vacation-balance audit trail ----------------------------------------
// Append-only. Employees see their own history; admins see everyone's.
export const BalanceLog = {
  forEmployee: (empId, limit = 20) => db.list('ta_balance_adjustments',
    `employee_id=eq.${empId}&select=*,changed:ta_profiles!changed_by(full_name)&order=created_at.desc&limit=${limit}`),
  recent: (limit = 50) => db.list('ta_balance_adjustments',
    `select=*,ta_profiles!employee_id(full_name,department,avatar_url),changed:ta_profiles!changed_by(full_name)&order=created_at.desc&limit=${limit}`),
};

// ---- Leave requests -------------------------------------------------------
// Two-stage approval (db/schema-v3.sql): a request is created `pending` and
// carries an independent decision slot for the manager and for the admin.
// It becomes `approved` — and ONLY THEN is the balance deducted — once every
// required slot has approved. A rejection from either slot denies it outright.
export const Leaves = {
  mine: (empId = userId()) => db.list('ta_leave_requests', `employee_id=eq.${empId}&select=*&order=created_at.desc`),
  // ta_leave_requests now has FOUR FKs to ta_profiles (employee_id, reviewed_by,
  // manager_by, admin_by), so every embed MUST name the FK it means.
  // !employee_id = the requester's profile; the response key stays "ta_profiles".
  pending: () => db.list('ta_leave_requests', `status=eq.pending&select=*,ta_profiles!employee_id(full_name,department,avatar_url)&order=created_at.asc`),
  all: () => db.list('ta_leave_requests', `select=*,ta_profiles!employee_id(full_name,department,avatar_url)&order=created_at.desc`),
  forMonth: (empId, y, m) => {
    const from = ymd(new Date(y, m, 1)), to = ymd(new Date(y, m + 1, 0));
    // Any request that overlaps the month at all.
    return db.list('ta_leave_requests',
      `employee_id=eq.${empId}&start_date=lte.${to}&end_date=gte.${from}&select=*&order=start_date.asc`);
  },
  // Submitting NEVER moves a balance — the RPC creates a pending row only.
  request: ({ type, start, end, reason, attachmentPath, attachmentName }) =>
    db.rpc('ta_request_leave', {
      p_leave_type: type, p_start: start, p_end: end,
      p_reason: reason || null,
      p_attachment_path: attachmentPath || null,
      p_attachment_name: attachmentName || null,
    }),
  review: (id, decision, note) => db.rpc('ta_review_leave',
    { p_request_id: id, p_decision: decision, p_note: note || null }),
  // Days requested but not yet decided. They don't touch the balance, but they
  // do reduce what can still be requested.
  pendingDays: (rows, type) => (rows || [])
    .filter(r => r.status === 'pending' && (!type || r.leave_type === type))
    .reduce((s, r) => s + r.days, 0),
};

// The workflow stage shown in the UI — mirrors public.ta_leave_stage().
//   pending | waiting_admin | waiting_manager | approved | denied
export function leaveStage(r) {
  if (!r) return 'pending';
  if (r.status === 'approved') return 'approved';
  if (r.status === 'denied') return 'denied';
  if (r.manager_decision === 'denied' || r.admin_decision === 'denied') return 'denied';
  const needAdmin = r.requires_admin !== false && !r.admin_decision;
  const needMgr = r.requires_manager !== false && !r.manager_decision;
  if (needAdmin && needMgr) return 'pending';
  if (needAdmin) return 'waiting_admin';
  if (needMgr) return 'waiting_manager';
  return 'approved';
}

export const STAGE_LABEL = {
  pending: 'Pending',
  waiting_admin: 'Waiting for Admin',
  waiting_manager: 'Waiting for Manager',
  approved: 'Approved',
  denied: 'Rejected',
};

// Which pill class each stage maps onto (reuses the existing pill palette).
export const STAGE_PILL = {
  pending: 'pending',
  waiting_admin: 'working',
  waiting_manager: 'working',
  approved: 'approved',
  denied: 'denied',
};

// Can this viewer still record a decision on this request?
export function canReview(r, profile) {
  if (!r || !profile || r.status !== 'pending') return false;
  if (r.employee_id === profile.id) return false;         // never your own
  if (profile.role === 'admin' && r.requires_admin !== false && !r.admin_decision) return true;
  if (profile.is_manager && r.requires_manager !== false && !r.manager_decision) return true;
  return false;
}

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

// ---- Settings (geofence + approval flow) ---------------------------------
export const Settings = {
  get: () => db.one('ta_settings', 'id=eq.true&select=*'),
  setApprovalFlow: ({ requireManager, requireAdmin }) => db.rpc('ta_set_approval_flow',
    { p_require_manager: requireManager, p_require_admin: requireAdmin }),
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

// ---- Work shifts ----------------------------------------------------------
// Reference data: everyone reads it (an employee's schedule card names their
// shift), only ta_set_shift() can change it.
export const Shifts = {
  all: () => db.list('ta_shifts', 'select=*&order=sort_order.asc'),
  active: () => db.list('ta_shifts', 'is_active=is.true&select=*&order=sort_order.asc'),
  save: (id, { name = null, start = null, end = null, active = null }) => db.rpc('ta_set_shift',
    { p_shift: id, p_name: name, p_start: start, p_end: end, p_active: active }),
};

// ---- Salary & attendance rules -------------------------------------------
// One row per employee, read-only over PostgREST for EVERYONE including admins
// (db/schema-v7.sql revokes the write grants and creates no write policy). An
// admin changes a rule through ta_set_salary_rules(), which re-checks every
// bound and writes the weekly days off into the existing ta_weekly_off_days
// table rather than duplicating the schedule.
//
// Weekly days off are NOT a column here — read them with OffDays.mine(id).
export const SalaryRules = {
  mine: (empId = userId()) => db.one('ta_salary_rules', `employee_id=eq.${empId}&select=*`),
  forEmployee: (empId) => db.one('ta_salary_rules', `employee_id=eq.${empId}&select=*`),
  all: () => db.list('ta_salary_rules', 'select=*'),
  // Every field is optional: omit one and the stored value is kept.
  // `offDays` is the ONLY way to change the schedule from this screen; pass
  // null to leave it alone. `clearOverrides` drops the per-employee shift
  // times and the daily late cap back to the shift's own hours.
  save: (empId, p = {}) => db.rpc('ta_set_salary_rules', {
    p_employee: empId,
    p_monthly_salary: nn(p.salary),
    p_shift: p.shiftId ?? null,
    p_grace: nn(p.grace),
    p_late_per_minute: nn(p.latePerMinute),
    p_absence_basis: p.absenceBasis ?? null,
    p_absence_fixed_days: nn(p.absenceFixedDays),
    p_absence_multiplier: nn(p.absenceMultiplier),
    p_off_days: p.offDays ?? null,
    p_is_active: p.isActive ?? null,
    p_shift_start: p.shiftStart ?? null,
    p_shift_end: p.shiftEnd ?? null,
    p_late_cap: nn(p.lateCap),
    p_clear_overrides: !!p.clearOverrides,
    p_note: p.note ?? null,
    p_permissions_per_month: nn(p.permissionsPerMonth),
    p_permission_deduction_enabled: p.permissionDeductionEnabled ?? null,
    p_permission_deduction_mode: p.permissionDeductionMode ?? null,
    p_permission_deduction_rate: nn(p.permissionDeductionRate),
  }),
};

// A blank input must reach the RPC as null (= "leave it alone"), never as NaN.
function nn(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---- Company holidays -----------------------------------------------------
export const Holidays = {
  all: () => db.list('ta_holidays', 'select=*&order=holiday_date.asc'),
  forYear: (y) => db.list('ta_holidays',
    `holiday_date=gte.${y}-01-01&holiday_date=lte.${y}-12-31&select=*&order=holiday_date.asc`),
  set: (date, name) => db.rpc('ta_set_holiday', { p_date: date, p_name: name || 'Holiday' }),
  remove: (date) => db.rpc('ta_delete_holiday', { p_date: date }),
};

// ---- Payroll --------------------------------------------------------------
// Derived, never stored: ta_payroll() recomputes the month from attendance,
// leave, permissions, rest days, off days and holidays on every call. Calling
// it twice can therefore never produce a second deduction — there is nothing
// to duplicate. The only stored money rows are the manual "other deductions"
// below, which are keyed uniquely on (employee, month, label).
//
// `month` is 0-based here to match Date#getMonth() and the rest of this app;
// the RPC takes 1-12, so it is converted at the boundary.
export const Payroll = {
  forEmployee: (empId, y, month) => db.rpc('ta_payroll',
    { p_employee: empId, p_year: y, p_month: month + 1 }),
  mine: (y, month) => db.rpc('ta_payroll',
    { p_employee: userId(), p_year: y, p_month: month + 1 }),
  all: (y, month, includeInactive = false) => db.rpc('ta_payroll_all',
    { p_year: y, p_month: month + 1, p_include_inactive: !!includeInactive }),
  // Re-sending the same label for the same month UPDATES that deduction
  // instead of adding a second one.
  setDeduction: (empId, y, month, label, amount, note) => db.rpc('ta_set_payroll_adjustment',
    { p_employee: empId, p_year: y, p_month: month + 1, p_label: label, p_amount: amount, p_note: note || null }),
  removeDeduction: (id) => db.rpc('ta_delete_payroll_adjustment', { p_id: id }),
  setDefaults: ({ timezone = null, salary = null, grace = null, latePerMinute = null, permissions = null }) =>
    db.rpc('ta_set_payroll_defaults', {
      p_timezone: timezone, p_salary: nn(salary), p_grace: nn(grace),
      p_late_per_minute: nn(latePerMinute), p_permissions: nn(permissions),
    }),
};

// ---- Monthly leave permissions -------------------------------------------
// Permission to step out DURING a working day — NOT vacation. Vacation lives
// in ta_leave_requests, deducts a balance and needs two-stage approval; a
// permission covers hours inside one day, deducts nothing, and the first three
// of each calendar month are approved the instant they are submitted.
//
// The status is decided by ta_request_permission() in the database, from a
// count it does itself. The client cannot ask for "approved" — it cannot
// INSERT into the table at all.
export const Permissions = {
  mine: (empId = userId()) => db.list('ta_leave_permissions',
    `employee_id=eq.${empId}&select=*&order=permission_date.desc,start_time.desc`),
  forMonth: (empId, y, m) => {
    const from = ymd(new Date(y, m, 1)), to = ymd(new Date(y, m + 1, 0));
    return db.list('ta_leave_permissions',
      `employee_id=eq.${empId}&permission_date=gte.${from}&permission_date=lte.${to}`
      + '&select=*&order=permission_date.asc,start_time.asc');
  },
  // ta_leave_permissions has two FKs to ta_profiles (employee_id, decided_by),
  // so every embed must name the one it means.
  all: () => db.list('ta_leave_permissions',
    'select=*,ta_profiles!employee_id(full_name,department,position,avatar_url),'
    + 'decided:ta_profiles!decided_by(full_name)&order=permission_date.desc,created_at.desc&limit=400'),
  pending: () => db.list('ta_leave_permissions',
    'status=eq.pending&select=*,ta_profiles!employee_id(full_name,department,position,avatar_url)'
    + '&order=permission_date.asc,start_time.asc'),
  // Every approved permission on one date — used by the admin attendance view.
  approvedOn: (date) => db.list('ta_leave_permissions',
    `permission_date=eq.${date}&status=eq.approved`
    + '&select=*,ta_profiles!employee_id(full_name,department,avatar_url)&order=start_time.asc'),
  // { limit, used, pending, remaining, next_requires_approval }
  usage: (empId = null, y = null, m = null) => db.rpc('ta_permission_usage',
    { p_employee: empId, p_year: y, p_month: m == null ? null : m + 1 }),
  request: ({ date, start, end, reason }) => db.rpc('ta_request_permission',
    { p_date: date, p_start: start, p_end: end, p_reason: reason || null }),
  review: (id, decision, note) => db.rpc('ta_review_permission',
    { p_id: id, p_decision: decision, p_note: note || null }),
  cancel: (id) => db.rpc('ta_cancel_permission', { p_id: id }),
};

export const PERMISSION_LABEL = {
  approved: 'Approved',
  pending: 'Pending Admin Approval',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};
// Reuses the existing pill palette — no new status colours.
export const PERMISSION_PILL = {
  approved: 'approved',
  pending: 'pending',
  rejected: 'denied',
  cancelled: 'plain',
};
