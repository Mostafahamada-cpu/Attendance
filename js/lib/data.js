// Domain data access — all ta_* tables. Thin wrappers over supabase db.
import { db, userId } from './supabase.js';
import { todayYMD, ymd } from './time.js';

// ---- Profiles -------------------------------------------------------------
export const Profiles = {
  me: () => db.one('ta_profiles', `id=eq.${userId()}&select=*`),
  all: () => db.list('ta_profiles', 'select=*&order=full_name.asc'),
  get: (id) => db.one('ta_profiles', `id=eq.${id}&select=*`),
  update: (id, patch) => db.update('ta_profiles', `id=eq.${id}`, patch),
};

// ---- Attendance -----------------------------------------------------------
export const Attendance = {
  today: (empId = userId()) => db.one('ta_attendance', `employee_id=eq.${empId}&work_date=eq.${todayYMD()}&select=*`),
  forMonth: (empId, y, m) => {
    const from = ymd(new Date(y, m, 1)), to = ymd(new Date(y, m + 1, 0));
    return db.list('ta_attendance', `employee_id=eq.${empId}&work_date=gte.${from}&work_date=lte.${to}&select=*&order=work_date.asc`);
  },
  range: (from, to) => db.list('ta_attendance', `work_date=gte.${from}&work_date=lte.${to}&select=*,ta_profiles(full_name,department,position,avatar_url)&order=clock_in.desc`),
  clockIn: () => db.create('ta_attendance', { employee_id: userId(), work_date: todayYMD(), clock_in: new Date().toISOString(), status: 'working' }),
  clockOut: (id, minutes) => db.update('ta_attendance', `id=eq.${id}`, { clock_out: new Date().toISOString(), total_minutes: minutes, status: 'completed' }),
};

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

// ---- Notifications --------------------------------------------------------
export const Notifs = {
  mine: (empId = userId()) => db.list('ta_notifications', `employee_id=eq.${empId}&select=*&order=created_at.desc&limit=50`),
  unread: (empId = userId()) => db.list('ta_notifications', `employee_id=eq.${empId}&is_read=eq.false&select=id`),
  markRead: (id) => db.update('ta_notifications', `id=eq.${id}`, { is_read: true }),
  markAllRead: (empId = userId()) => db.update('ta_notifications', `employee_id=eq.${empId}&is_read=eq.false`, { is_read: true }),
};
