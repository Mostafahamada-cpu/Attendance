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
  not_in:     { label: 'Not clocked in', pill: 'plain', costs: false },
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

// ---- Late-arrival tiers (v8) ------------------------------------------------
// THE rule lives in the ta_late_tiers table and every deduction is priced by
// ta_late_deduction() in the database. These helpers only DESCRIBE that rule
// for the screens; the fallback below is the seeded default and is used solely
// when a screen has no server copy yet (pre-v8 database).
//
// Boundary rule, identical to ta_late_tier(): a tier applies when the arrival
// is STRICTLY MORE than its threshold late, so 15 min → free, 16 min → ¼ day,
// 30 → ¼, 31 → ½, 60 → ½, 61 → full.
export const DEFAULT_LATE_TIERS = [
  { threshold_minutes: 15, deduction_days: 0.25, label: 'Quarter day' },
  { threshold_minutes: 30, deduction_days: 0.5,  label: 'Half day' },
  { threshold_minutes: 60, deduction_days: 1,    label: 'Full day' },
];

export const LATE_MODES = [
  ['tiered',     'Company tiers',     'quarter / half / full day of pay, by how late'],
  ['per_minute', 'Per minute (legacy)', 'grace period, then a fixed amount per late minute'],
];

// The tier `lateMinutes` falls into, or null inside the free window.
export function lateTierFor(lateMinutes, tiers = DEFAULT_LATE_TIERS) {
  const m = Math.max(0, Math.floor(Number(lateMinutes) || 0));
  let hit = null;
  for (const t of [...(tiers || [])].sort((a, b) => a.threshold_minutes - b.threshold_minutes)) {
    if (m > t.threshold_minutes) hit = t;
  }
  return hit;
}

// The free window = the lowest threshold.
export function lateGrace(tiers = DEFAULT_LATE_TIERS) {
  const ts = (tiers || []).map(t => Number(t.threshold_minutes)).filter(Number.isFinite);
  return ts.length ? Math.min(...ts) : 15;
}

// 0.25 → '¼ day' · 0.5 → '½ day' · 1 → '1 day' · 1.5 → '1.5 days'
export function dayFraction(v) {
  const n = Number(v || 0);
  if (n === 0.25) return '¼ day';
  if (n === 0.5) return '½ day';
  if (n === 0.75) return '¾ day';
  if (n === 1) return '1 day';
  return `${n} days`;
}

// One line per tier, e.g. 'Up to 15 min: free · >15 min: ¼ day · >30 min: ½ day · >60 min: 1 day'
export function lateTiersSummary(tiers = DEFAULT_LATE_TIERS) {
  const sorted = [...(tiers || [])].sort((a, b) => a.threshold_minutes - b.threshold_minutes);
  if (!sorted.length) return 'No late deduction';
  const parts = [`Up to ${sorted[0].threshold_minutes} min: free`];
  for (const t of sorted) parts.push(`>${t.threshold_minutes} min: ${dayFraction(t.deduction_days)}`);
  return parts.join(' · ');
}

// The sentence for a rules card, whichever rule the employee is on.
export function lateRuleSummary(rules) {
  if ((rules?.late_mode || 'tiered') === 'per_minute') {
    return `${rules.grace_minutes ?? 15} min grace, then ${egp(rules.late_deduction_per_minute ?? 1)} per minute`
      + (rules.late_deduction_cap_per_day ? ` (max ${egp(rules.late_deduction_cap_per_day)}/day)` : '');
  }
  return lateTiersSummary(rules?.late_tiers || DEFAULT_LATE_TIERS);
}

// Why one late day cost what it did — reads the figures ta_payroll() stored on
// the day entry, so the explanation can never disagree with the amount.
export function lateReason(day, rules) {
  const arrived = day.clock_in_local ? `arrived ${hm12(day.clock_in_local)} · ` : '';
  const shift = rules?.shift_start ? ` (shift starts ${hm12(rules.shift_start)})` : '';
  if ((rules?.late_mode || 'tiered') === 'per_minute') {
    return `${arrived}${day.late_minutes} min late${shift} · ${day.billable_minutes} billable after the ${rules.grace_minutes} min grace`;
  }
  const frac = Number(day.late_days || 0);
  return `${arrived}${day.late_minutes} min late${shift} → ${day.late_label || 'late'}`
    + (frac > 0 ? ` = ${dayFraction(frac)} × ${egp(rules?.daily_rate ?? day.daily_rate ?? 0)} daily rate` : '');
}
