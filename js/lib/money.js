// Payroll formatting + the vocabulary the salary screens share.
//
// Every figure shown by these helpers was computed by ta_payroll() in the
// database. Nothing here does payroll arithmetic — it only renders what the
// server already decided, so a value cannot drift between two screens.

export const CURRENCY = 'EGP';

// 6000 → '6,000 EGP' · 1234.5 → '1,234.50 EGP'
export function egp(v, { withCode = true } = {}) {
  const n = Number(v || 0);
  const s = n.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return withCode ? `${s} ${CURRENCY}` : s;
}

// A deduction reads better with its sign: 0 → '—', 45 → '−45 EGP'
export function deduction(v) {
  const n = Number(v || 0);
  return n <= 0 ? '—' : '−' + egp(n);
}

// 90 → '1h 30m' · 45 → '45m' · 0 → '0m'
export function mins(v) {
  const n = Math.max(0, Math.round(Number(v) || 0));
  if (n < 60) return n + 'm';
  const h = Math.floor(n / 60), m = n % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// '10:00' → '10:00 AM'. Accepts 'HH:MM' or 'HH:MM:SS' as stored in Postgres.
export function hm12(t) {
  if (!t) return '—';
  const [hRaw, mRaw] = String(t).split(':');
  const h = Number(hRaw), m = Number(mRaw || 0);
  if (!Number.isFinite(h)) return String(t);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// 'HH:MM' for an <input type="time"> from a Postgres time value.
export function timeInputValue(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':');
  return `${String(h).padStart(2, '0')}:${String(m || '00').padStart(2, '0')}`;
}

// The day types ta_payroll() returns, and how each is shown. `pill` reuses the
// existing status-pill palette — no new colours were introduced for payroll.
export const DAY_TYPES = {
  present:    { label: 'Present',    pill: 'present',  costs: false },
  late:       { label: 'Late',       pill: 'pending',  costs: true  },
  absent:     { label: 'Absent',     pill: 'denied',   costs: true  },
  leave:      { label: 'Vacation',   pill: 'approved', costs: false },
  rest_day:   { label: 'Rest Day',   pill: 'working',  costs: false },
  permission: { label: 'Permission', pill: 'working',  costs: false },
  weekly_off: { label: 'Day Off',    pill: 'weekend',  costs: false },
  holiday:    { label: 'Holiday',    pill: 'weekend',  costs: false },
  upcoming:   { label: 'Upcoming',   pill: 'plain',    costs: false },
};
export function dayType(t) { return DAY_TYPES[t] || { label: t || '—', pill: 'plain', costs: false }; }

export const ABSENCE_BASIS = {
  scheduled:  'Scheduled working days that month',
  fixed_days: 'A fixed number of days per month',
};

export const PERMISSION_MODES = [
  ['per_minute',     'Per minute',     'rate x every approved permission minute'],
  ['per_occurrence', 'Per permission', 'rate x the number of approved permissions'],
  ['fixed',          'Fixed monthly',  'one flat charge if any permission was used'],
];

// A plain-English sentence explaining how one employee's daily rate is reached
// — the answer to "why was that much taken off for one absent day?".
export function dailyRateExplainer(rules, totals) {
  if (rules.absence_basis === 'fixed_days') {
    return `${egp(rules.monthly_salary)} ÷ ${rules.absence_fixed_days} days = ${egp(totals.daily_rate)} per day`;
  }
  return `${egp(rules.monthly_salary)} ÷ ${totals.working_days} scheduled working day(s) = ${egp(totals.daily_rate)} per day`;
}
