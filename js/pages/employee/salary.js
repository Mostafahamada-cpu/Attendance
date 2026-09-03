// Employee → My Salary & Schedule.
//
// Your own figures only. ta_payroll() refuses any employee_id other than the
// caller's unless the caller is an admin, so this screen physically cannot be
// pointed at a colleague — and the salary tables have no write grant for
// anyone, so nothing here can be edited from the browser either.
import { Payroll, Permissions } from '../../lib/data.js?v=20260903a';
import { el, icon, ring, pageHead, emptyState } from '../../lib/ui.js?v=20260903a';
import { MONTHS, DOW, DOW_FULL, fmtDayMon } from '../../lib/time.js?v=20260903a';
import { egp, deduction, mins, hm12, dayType, dailyRateExplainer } from '../../lib/money.js?v=20260903a';

export default async function empSalary({ profile, navigate }) {
  const now = new Date();
  let year = now.getFullYear(), month = now.getMonth();

  const screen = el('div.screen.fade-up');
  screen.append(pageHead('My Salary & Schedule', () => navigate('#/more')));

  // ── Month picker ──────────────────────────────────────────────────────────
  const head = el('div.cal-head', { style: { marginBottom: '14px' } });
  const moLabel = el('div.mo');
  const nav = el('div.cal-nav');
  const prev = el('button', { 'aria-label': 'Previous month', html: icon('chevL') });
  const next = el('button', { 'aria-label': 'Next month', html: icon('chevR') });
  nav.append(prev, next);
  head.append(moLabel, nav);
  screen.append(head);

  const host = el('div');
  screen.append(host);

  async function draw() {
    moLabel.textContent = `${MONTHS[month]} ${year}`;
    host.replaceChildren(el('div.card.center-text.muted.small', { style: { padding: '24px' } }, 'Calculating…'));
    let pay, usage;
    try {
      [pay, usage] = await Promise.all([
        Payroll.mine(year, month),
        Permissions.usage(null, year, month).catch(() => null),
      ]);
    } catch (e) {
      host.replaceChildren(el('div.card', emptyState('alert', 'Could not load your salary', e.message)));
      return;
    }
    host.replaceChildren(...body(pay, usage, year, month));
  }

  prev.addEventListener('click', () => { month--; if (month < 0) { month = 11; year--; } draw(); });
  next.addEventListener('click', () => { month++; if (month > 11) { month = 0; year++; } draw(); });

  await draw();
  return screen;
}

function body(pay, usage, year, month) {
  const { rules: r, totals: t, days } = pay;
  const out = [];

  // ── Net salary headline ───────────────────────────────────────────────────
  const netCard = el('div.card');
  const top = el('div.row', { style: { gap: '18px' } });
  top.append(ring({
    value: Math.max(0, t.net_salary), max: t.base_salary || 1, size: 100, stroke: 10,
    color: 'var(--teal)', label: egp(t.net_salary, { withCode: false }), sub: 'EGP',
  }));
  const side = el('div.grow', { style: { display: 'grid', gap: '8px' } });
  side.append(
    kvBig('Base salary', egp(t.base_salary)),
    kvBig('Total deductions', t.total_deductions > 0 ? deduction(t.total_deductions) : '—',
      t.total_deductions > 0 ? 'var(--danger)' : null),
    kvBig('Net salary', egp(t.net_salary), 'var(--teal)'),
  );
  top.append(side);
  netCard.append(top);
  if (pay.period.is_current) {
    netCard.append(el('p.tiny.muted', { style: { marginTop: '12px' } },
      `Estimated so far — this month is still running, counted up to ${fmtDayMon(pay.period.counted_to)}.`));
  }
  out.push(netCard);

  // ── Schedule ──────────────────────────────────────────────────────────────
  out.push(sectionHead('My work schedule'));
  const sched = el('div.card');
  const sl = el('div', { style: { display: 'grid', gap: '9px' } });
  sl.append(
    kv('Shift', `${r.shift_name} · ${hm12(r.shift_start)} – ${hm12(r.shift_end)}`),
    kv('Grace period', `${r.grace_minutes} minutes after ${hm12(r.shift_start)}`),
    kv('Late deduction', `${egp(r.late_deduction_per_minute)} per minute past the grace`),
    kv('Daily rate', dailyRateExplainer(r, t)),
    kv('Status', r.is_active === false ? 'Inactive' : 'Active'),
  );
  sched.append(sl);

  sched.append(el('div.tiny.b', { style: { marginTop: '14px', marginBottom: '7px' } }, 'Weekly days off'));
  const chips = el('div.row.wrap', { style: { gap: '6px' } });
  if (!(r.off_days || []).length) chips.append(el('span.tiny.muted', 'None set — ask your admin.'));
  for (const d of r.off_days || []) chips.append(el('span.pill.pill--weekend', DOW_FULL[d]));
  sched.append(chips);
  sched.append(el('p.tiny.muted', { style: { marginTop: '10px' } },
    'A day off never counts as an absence. Neither does approved vacation, an approved rest day or a company holiday.'));
  out.push(sched);

  // ── Attendance summary ────────────────────────────────────────────────────
  out.push(sectionHead(`${MONTHS[month]} at a glance`));
  const grid = el('div.stat-3', { style: { marginBottom: '4px' } });
  grid.append(
    stat('checkcircle', 'Present', String(t.days_present)),
    stat('clock', 'Late days', String(t.late_days)),
    stat('alert', 'Absent', String(t.absence_days)),
  );
  const grid2 = el('div.stat-3', { style: { marginTop: '10px' } });
  grid2.append(
    stat('calendar', 'Working days', String(t.working_days)),
    stat('coffee', 'Vacation', String(t.leave_days)),
    stat('moon', 'Rest days', String(t.rest_days)),
  );
  out.push(el('div.card', grid, grid2));

  // ── Leave permissions ─────────────────────────────────────────────────────
  if (usage) {
    out.push(sectionHead('Leave permissions'));
    const pc = el('div.card');
    const prow = el('div.row.between', { style: { gap: '12px' } });
    prow.append(el('div.grow',
      el('div.b', `Used ${usage.used} / ${usage.limit}`),
      el('div.tiny.muted', usage.remaining > 0
        ? `${usage.remaining} left — approved automatically`
        : 'Allowance used — a new request needs admin approval')));
    prow.append(el('span.pill.pill--' + (usage.remaining > 0 ? 'approved' : 'pending'),
      `${t.permission_count} this month · ${mins(t.permission_minutes)}`));
    pc.append(prow);
    if (r.permission_deduction_enabled) {
      pc.append(el('p.tiny.muted', { style: { marginTop: '10px' } },
        `Approved permissions are deducted at ${egp(r.permission_deduction_rate)} `
        + (r.permission_deduction_mode === 'per_occurrence' ? 'per permission'
          : r.permission_deduction_mode === 'fixed' ? 'per month' : 'per minute') + '.'));
    } else {
      pc.append(el('p.tiny.muted', { style: { marginTop: '10px' } },
        'Approved permissions do not reduce your salary.'));
    }
    out.push(pc);
  }

  // ── Deductions, explained ─────────────────────────────────────────────────
  out.push(sectionHead('My deductions'));
  const ded = el('div.card');
  const lines = [
    ['Late arrivals', t.late_deduction, `${t.late_days} day(s) · ${mins(t.total_late_minutes)} billable`],
    ['Absences', t.absence_deduction, `${t.absence_days} day(s) at ${egp(t.daily_rate)}`],
    ['Leave permissions', t.permission_deduction, `${t.permission_count} approved · ${mins(t.permission_minutes)}`],
    ['Other', t.other_deductions, (pay.adjustments || []).map(a => a.label).join(', ') || 'None'],
  ];
  for (const [label, amount, sub] of lines) {
    const row = el('div.row.between', { style: { padding: '10px 0', borderBottom: '1px solid var(--line)', gap: '10px' } });
    row.append(el('div.grow', el('div.small.b', label), el('div.tiny.muted', sub)));
    row.append(el('div.small.b', { style: { color: Number(amount) > 0 ? 'var(--danger)' : 'var(--ink-3)' } },
      Number(amount) > 0 ? deduction(amount) : '—'));
    ded.append(row);
  }
  const totalRow = el('div.row.between', { style: { paddingTop: '12px', gap: '10px' } });
  totalRow.append(el('span.b', 'Total deductions'),
    el('span.b', { style: { color: t.total_deductions > 0 ? 'var(--danger)' : 'var(--ink-3)' } },
      t.total_deductions > 0 ? deduction(t.total_deductions) : '—'));
  ded.append(totalRow);
  out.push(ded);

  // ── Day by day ────────────────────────────────────────────────────────────
  const shown = days.filter(d => d.type !== 'upcoming');
  out.push(sectionHead('Attendance history'));
  if (!shown.length) {
    out.push(el('div.card', emptyState('calendar', 'Nothing recorded yet this month')));
  } else {
    const list = el('div.list');
    for (const d of [...shown].reverse()) {
      const meta = dayType(d.type);
      const row = el('div.lrow');
      row.append(el('div.grow',
        el('div.name', `${fmtDayMon(d.date)} · ${DOW[d.dow]}`),
        el('div.meta', d.clock_in_local
          ? `${hm12(d.clock_in_local)} – ${d.clock_out_local ? hm12(d.clock_out_local) : '—'}`
            + (d.worked_minutes ? ` · ${mins(d.worked_minutes)}` : '')
            + (d.billable_minutes ? ` · ${d.billable_minutes} billable late min` : '')
          : (d.holiday || meta.label))));
      const dedAmt = Number(d.deduction || 0) + Number(d.permission_deduction || 0);
      if (dedAmt > 0) {
        row.append(el('div.small.b', { style: { color: 'var(--danger)', whiteSpace: 'nowrap' } }, deduction(dedAmt)));
      }
      row.append(el('span.pill.pill--' + meta.pill, d.holiday ? 'Holiday' : meta.label));
      list.append(row);
    }
    out.push(list);
  }

  out.push(el('p.tiny.muted.center-text', { style: { marginTop: '16px' } },
    'These figures are calculated by the server from your attendance record. '
    + 'Contact your admin if something looks wrong.'));

  return out;
}

// ---- pieces ---------------------------------------------------------------
function sectionHead(title) {
  const h = el('div.section-h');
  h.append(el('h2', title));
  return h;
}
function kv(k, v) {
  const r = el('div.row.between', { style: { gap: '12px' } });
  r.append(el('span.small.muted', k), el('span.small.b', { style: { textAlign: 'right' } }, v));
  return r;
}
function kvBig(k, v, color) {
  const r = el('div.row.between', { style: { gap: '12px' } });
  r.append(el('span.small.muted', k), el('span.b', { style: { color: color || null } }, v));
  return r;
}
function stat(ic, label, value) {
  const t = el('div.stat');
  t.innerHTML = `<div class="ic">${icon(ic)}</div><div class="v">${value}</div><div class="k">${label}</div>`;
  return t;
}
