// Admin → Payroll.
//
// Everything on this screen is DERIVED. ta_payroll_all() re-reads attendance,
// leave, permissions, rest days, off days and holidays and returns the month;
// no row is written when the page loads, so refreshing it a hundred times
// gives the same numbers a hundred times and can never create a duplicate
// deduction. The only stored money is the manual "other deductions" list in
// the breakdown dialog, and even that is keyed uniquely on
// (employee, month, label) — re-entering the same label edits it in place.
import { Payroll } from '../../lib/data.js?v=20260903a';
import { el, icon, avatar, emptyState } from '../../lib/ui.js?v=20260903a';
import { toastOk, toastErr, modal, confirmDialog } from '../../lib/toast.js?v=20260903a';
import { MONTHS, DOW, fmtShortDate, fmtDayMon } from '../../lib/time.js?v=20260903a';
import { egp, deduction, mins, hm12, dayType, dailyRateExplainer } from '../../lib/money.js?v=20260903a';

export default async function adminPayroll() {
  const now = new Date();
  let year = now.getFullYear(), month = now.getMonth();
  let includeInactive = false;
  let rows = [];

  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Payroll'),
    el('p.muted.small', 'Calculated from attendance for the month you pick. '
      + 'Open any employee for a day-by-day explanation of every EGP deducted.')));

  // ── Month picker ──────────────────────────────────────────────────────────
  const bar = el('div.row.wrap.between', { style: { gap: '12px', marginBottom: '18px' } });
  const picker = el('div.cal-nav', { style: { gap: '8px' } });
  const prev = el('button', { 'aria-label': 'Previous month', html: icon('chevL') });
  const label = el('div.b', { style: { minWidth: '160px', textAlign: 'center', fontSize: '15px' } });
  const next = el('button', { 'aria-label': 'Next month', html: icon('chevR') });
  const thisMonth = el('button', { style: { width: 'auto', padding: '0 14px', fontSize: '13px', fontWeight: '700' } }, 'This month');
  picker.append(prev, label, next, thisMonth);

  const right = el('div.row.wrap', { style: { gap: '10px' } });
  const inactiveBtn = el('button.btn.btn--pill-line.btn--sm', 'Show inactive');
  inactiveBtn.addEventListener('click', () => {
    includeInactive = !includeInactive;
    inactiveBtn.textContent = includeInactive ? 'Hide inactive' : 'Show inactive';
    load();
  });
  right.append(inactiveBtn);
  bar.append(picker, right);
  screen.append(bar);

  const kpiGrid = el('div.kpi-grid');
  screen.append(kpiGrid);

  const wrap = el('div.table-wrap', { style: { marginTop: '18px' } });
  const table = el('table.tbl.tbl--wide');
  wrap.append(table);
  screen.append(wrap);

  const foot = el('p.tiny.muted', { style: { marginTop: '12px' } },
    'Net salary = base salary − (late + absence + permission + other deductions). '
    + 'Approved vacation, approved rest days, weekly days off and company holidays never produce an absence deduction.');
  screen.append(foot);

  async function load() {
    label.textContent = `${MONTHS[month]} ${year}`;
    table.replaceChildren(loadingRow());
    try {
      rows = await Payroll.all(year, month, includeInactive);
    } catch (e) {
      table.replaceChildren();
      kpiGrid.replaceChildren();
      wrap.replaceChildren(el('div.card', emptyState('alert', 'Payroll could not be calculated', e.message)));
      return;
    }
    if (!wrap.contains(table)) wrap.replaceChildren(table);
    drawKpis();
    drawTable();
  }

  function drawKpis() {
    const base = sum(rows, r => r.totals.base_salary);
    const ded = sum(rows, r => r.totals.total_deductions);
    const net = sum(rows, r => r.totals.net_salary);
    const lateMin = sum(rows, r => r.totals.total_late_minutes);
    const absent = sum(rows, r => r.totals.absence_days);
    kpiGrid.replaceChildren(
      kpi('users', 'teal', String(rows.length), 'Employees'),
      kpi('briefcase', 'blue', egp(base), 'Total base'),
      kpi('minus', 'danger', egp(ded), 'Total deductions'),
      kpi('trend', 'teal', egp(net), 'Total net'),
      kpi('clock', 'warn', mins(lateMin), 'Billable late time'),
      kpi('alert', 'warn', String(absent), 'Absence days'),
    );
  }

  function drawTable() {
    table.replaceChildren();
    const thead = el('thead');
    thead.innerHTML = '<tr><th>Employee</th><th>Role</th><th>Base salary</th><th>Working days</th>'
      + '<th>Present</th><th>Late days</th><th>Late minutes</th><th>Late deduction</th>'
      + '<th>Absence days</th><th>Absence deduction</th><th>Permissions</th><th>Other</th>'
      + '<th>Total deductions</th><th>Net salary</th><th></th></tr>';
    table.append(thead);

    const tbody = el('tbody');
    if (!rows.length) {
      const tr = el('tr'); const td = el('td', { colspan: '15' });
      td.append(emptyState('briefcase', 'Nothing to calculate', 'No active employees for this month.'));
      tr.append(td); tbody.append(tr);
    }
    for (const r of rows) {
      const t = r.totals, p = r.employee;
      const tr = el('tr');

      const who = el('td');
      const line = el('div.row', { style: { gap: '10px' } });
      const nameLine = el('div.row', { style: { gap: '7px' } }, el('span.b', p.full_name));
      if (r.rules.is_active === false) {
        nameLine.append(el('span.pill.pill--denied', { style: { height: '20px', fontSize: '10.5px', padding: '0 8px' } }, 'Inactive'));
      }
      line.append(avatar(p, 'sm'), el('div', nameLine, el('div.tiny.muted', p.department || '—')));
      who.append(line);
      tr.append(who);

      tr.append(el('td.tiny', p.position || 'Employee'));
      tr.append(num(egp(t.base_salary), true));
      tr.append(num(String(t.working_days)));
      tr.append(num(String(t.days_present)));
      tr.append(num(String(t.late_days)));
      tr.append(num(mins(t.total_late_minutes)));
      tr.append(money(t.late_deduction));
      tr.append(num(String(t.absence_days)));
      tr.append(money(t.absence_deduction));

      const permCell = el('td', { style: { whiteSpace: 'nowrap' } });
      permCell.append(el('div.small.b', `${t.permission_count} · ${mins(t.permission_minutes)}`));
      permCell.append(el('div.tiny.muted', t.permission_deduction > 0 ? deduction(t.permission_deduction) : 'no deduction'));
      tr.append(permCell);

      tr.append(money(t.other_deductions));
      tr.append(money(t.total_deductions, true));
      tr.append(num(egp(t.net_salary), true));

      const act = el('td');
      const b = el('button.btn.btn--pill-line.btn--sm', 'Breakdown');
      b.addEventListener('click', () => openBreakdown(r, year, month, load));
      act.append(b);
      tr.append(act);

      tbody.append(tr);
    }
    table.append(tbody);
  }

  prev.addEventListener('click', () => { month--; if (month < 0) { month = 11; year--; } load(); });
  next.addEventListener('click', () => { month++; if (month > 11) { month = 0; year++; } load(); });
  thisMonth.addEventListener('click', () => { year = new Date().getFullYear(); month = new Date().getMonth(); load(); });

  await load();
  return screen;
}

// ─────────────────────────────────────────────────────────────────────────────
//  One employee's month, explained day by day
// ─────────────────────────────────────────────────────────────────────────────
export async function openBreakdown(summary, year, month, onChanged) {
  const empId = summary.employee.id;

  // The summary from ta_payroll_all() has no `days` — fetch the full record.
  document.querySelectorAll('.payroll-detail-scrim').forEach(n => n.remove());
  const scrim = el('div.modal-scrim.payroll-detail-scrim', { style: { placeItems: 'center' } });
  const panel = el('div.modal', { style: { maxWidth: '760px', maxHeight: '90vh', overflowY: 'auto', borderRadius: 'var(--r-xl)' } });
  const close = () => { scrim.remove(); window.removeEventListener('hashchange', close); };
  window.addEventListener('hashchange', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  panel.append(el('div.center-text.muted.small', { style: { padding: '20px' } }, 'Calculating…'));
  scrim.append(panel);
  document.body.append(scrim);

  let full;
  try {
    full = await Payroll.forEmployee(empId, year, month);
  } catch (e) {
    panel.replaceChildren(emptyState('alert', 'Could not load the breakdown', e.message));
    return;
  }
  panel.replaceChildren(breakdownBody(full, year, month, close, onChanged));
}

export function breakdownBody(pay, year, month, close, onChanged) {
  const { employee: p, rules, totals: t, days, adjustments, permissions } = pay;
  const box = el('div');

  // ── Head ──────────────────────────────────────────────────────────────────
  const head = el('div.row', { style: { gap: '14px', marginBottom: '16px' } });
  head.append(avatar(p, 'lg'));
  head.append(el('div.grow',
    el('div', { style: { fontSize: '18px', fontWeight: '800' } }, p.full_name),
    el('div.small.muted', `${p.position || 'Employee'} · ${p.department || 'General'}`),
    el('div.tiny.muted', `${MONTHS[month]} ${year} · ${pay.period.timezone}`)));
  if (close) {
    const x = el('button.cal-nav', { html: icon('x'), style: { flex: 'none', width: '38px' } });
    x.addEventListener('click', close);
    head.append(x);
  }
  box.append(head);

  // ── The bottom line ───────────────────────────────────────────────────────
  const money3 = el('div.stat-3', { style: { marginBottom: '16px' } });
  money3.append(
    bigStat('Base salary', egp(t.base_salary)),
    bigStat('Total deductions', deduction(t.total_deductions), t.total_deductions > 0 ? 'var(--danger)' : null),
    bigStat('Net salary', egp(t.net_salary), 'var(--teal)'),
  );
  box.append(money3);

  // ── The rules this was calculated with ────────────────────────────────────
  const rulesCard = el('div', {
    style: { padding: '13px 15px', background: 'var(--surface-2)', borderRadius: 'var(--r)', marginBottom: '16px' } });
  rulesCard.append(el('div.small.b', { style: { marginBottom: '8px' } }, 'Rules used'));
  const rl = el('div', { style: { display: 'grid', gap: '4px' } });
  rl.append(
    kv('Shift', `${rules.shift_name} · ${hm12(rules.shift_start)} – ${hm12(rules.shift_end)}`),
    kv('Grace period', `${rules.grace_minutes} minutes`),
    kv('Late deduction', `${egp(rules.late_deduction_per_minute)} per billable minute`
      + (rules.late_deduction_cap_per_day ? ` (capped at ${egp(rules.late_deduction_cap_per_day)}/day)` : '')),
    kv('Weekly days off', (rules.off_days || []).length ? rules.off_days.map(d => DOW[d]).join(', ') : 'None'),
    kv('Daily rate', dailyRateExplainer(rules, t)),
    kv('Leave permissions', `${rules.permissions_per_month} per month · `
      + (rules.permission_deduction_enabled
        ? `${egp(rules.permission_deduction_rate)} ${modeLabel(rules.permission_deduction_mode)}`
        : 'no deduction')),
  );
  rulesCard.append(rl);
  box.append(rulesCard);

  // ── Month at a glance ─────────────────────────────────────────────────────
  const counts = el('div.row.wrap', { style: { gap: '8px', marginBottom: '16px' } });
  counts.append(
    countPill('present', `${t.days_present} present`),
    countPill('pending', `${t.late_days} late`),
    countPill('denied', `${t.absence_days} absent`),
    countPill('approved', `${t.leave_days} vacation`),
    countPill('working', `${t.rest_days} rest`),
    countPill('weekend', `${t.off_days} days off`),
    countPill('weekend', `${t.holidays} holidays`),
    countPill('working', `${t.permission_count} permissions`),
  );
  box.append(counts);

  // ── Why money was deducted ────────────────────────────────────────────────
  box.append(el('div.section-h', el('h2', { style: { fontSize: '15px' } }, 'Why money was deducted')));

  const lateDays = days.filter(d => d.type === 'late');
  const absentDays = days.filter(d => d.type === 'absent');
  const permDays = days.filter(d => d.permission_deduction > 0);

  const why = el('div.list', { style: { marginBottom: '14px' } });
  if (lateDays.length) {
    why.append(reasonHead('Late arrivals', deduction(t.late_deduction)));
    for (const d of lateDays) {
      why.append(reasonRow(
        fmtDayMon(d.date),
        `arrived ${hm12(d.clock_in_local)} · ${d.late_minutes} min late, ${d.billable_minutes} billable after the ${rules.grace_minutes} min grace`,
        deduction(d.deduction)));
    }
  }
  if (absentDays.length) {
    why.append(reasonHead('Absences', deduction(t.absence_deduction)));
    for (const d of absentDays) {
      why.append(reasonRow(fmtDayMon(d.date),
        `scheduled working day with no attendance, no approved leave and no day off · ${egp(t.daily_rate)} daily rate`
        + (rules.absence_multiplier !== 1 ? ` x ${rules.absence_multiplier}` : ''),
        deduction(d.deduction)));
    }
  }
  if (permDays.length) {
    why.append(reasonHead('Leave permissions', deduction(t.permission_deduction)));
    for (const d of permDays) {
      why.append(reasonRow(fmtDayMon(d.date),
        `${d.permission_count} approved permission(s) · ${mins(d.permission_minutes)}`,
        deduction(d.permission_deduction)));
    }
  }
  if (rules.permission_deduction_enabled && rules.permission_deduction_mode === 'fixed' && t.permission_deduction > 0) {
    why.append(reasonHead('Leave permissions', deduction(t.permission_deduction)));
    why.append(reasonRow('Monthly charge', `${t.permission_count} permission(s) used`, deduction(t.permission_deduction)));
  }
  if (adjustments.length) {
    why.append(reasonHead('Other deductions', deduction(t.other_deductions)));
    for (const a of adjustments) {
      const row = reasonRow(a.label, a.note || 'Added by an admin', deduction(a.amount));
      const del = el('button', { 'aria-label': 'Remove ' + a.label, style: { color: 'var(--ink-3)', flex: 'none' }, html: icon('trash', 'ic-sm') });
      del.addEventListener('click', () => confirmDialog({
        title: 'Remove deduction?', message: `${a.label} — ${egp(a.amount)} will no longer be deducted.`,
        confirmLabel: 'Remove', danger: true,
        onConfirm: async () => {
          try { await Payroll.removeDeduction(a.id); toastOk('Deduction removed'); close?.(); onChanged?.(); }
          catch (e) { toastErr(e.message); }
        },
      }));
      row.append(del);
      why.append(row);
    }
  }
  if (!why.children.length) {
    why.append(el('div.card--flat', { style: { padding: '16px' } },
      emptyState('checkcircle', 'No deductions this month', 'Full salary — nothing was taken off.')));
  }
  box.append(why);

  const addBtn = el('button.btn.btn--pill-line.btn--sm', 'Add another deduction');
  addBtn.addEventListener('click', () => addDeduction(p, year, month, () => { close?.(); onChanged?.(); }));
  box.append(addBtn);

  // ── Approved permissions this month ──────────────────────────────────────
  if (permissions?.length) {
    box.append(el('div.section-h', { style: { marginTop: '18px' } },
      el('h2', { style: { fontSize: '15px' } }, 'Approved leave permissions')));
    const pl = el('div.list');
    for (const lp of permissions) {
      const row = el('div.lrow');
      row.append(el('div.grow',
        el('div.name', fmtShortDate(lp.permission_date)),
        el('div.meta', `${hm12(lp.start_time)} – ${hm12(lp.end_time)} · ${mins(lp.duration_minutes)}`
          + (lp.reason ? ` · ${lp.reason}` : ''))));
      row.append(el('span.pill.pill--' + (lp.approval_type === 'admin' ? 'working' : 'approved'),
        lp.approval_type === 'admin' ? 'Admin approved' : 'Auto approved'));
      pl.append(row);
    }
    box.append(pl);
  }

  // ── Day by day ────────────────────────────────────────────────────────────
  box.append(el('div.section-h', { style: { marginTop: '18px' } },
    el('h2', { style: { fontSize: '15px' } }, 'Day by day')));
  const dwrap = el('div.table-wrap');
  const dtable = el('table.tbl');
  const dhead = el('thead');
  dhead.innerHTML = '<tr><th>Date</th><th>Status</th><th>In</th><th>Out</th><th>Worked</th>'
    + '<th>Late</th><th>Billable</th><th>Permission</th><th>Deduction</th></tr>';
  dtable.append(dhead);
  const dbody = el('tbody');
  for (const d of days) {
    if (d.type === 'upcoming') continue;
    const meta = dayType(d.type);
    const tr = el('tr');
    tr.append(el('td', { style: { whiteSpace: 'nowrap' } },
      el('div.small.b', fmtDayMon(d.date)), el('div.tiny.muted', DOW[d.dow])));
    tr.append(el('td', el('span.pill.pill--' + meta.pill, d.holiday || meta.label)));
    tr.append(el('td.tiny', d.clock_in_local ? hm12(d.clock_in_local) : '—'));
    tr.append(el('td.tiny', d.clock_out_local ? hm12(d.clock_out_local) : '—'));
    tr.append(el('td.tiny', d.worked_minutes ? mins(d.worked_minutes) : '—'));
    tr.append(el('td.tiny', d.late_minutes ? mins(d.late_minutes) : '—'));
    tr.append(el('td.tiny', d.billable_minutes ? mins(d.billable_minutes) : '—'));
    tr.append(el('td.tiny', d.permission_minutes ? `${d.permission_count} · ${mins(d.permission_minutes)}` : '—'));
    const ded = Number(d.deduction || 0) + Number(d.permission_deduction || 0);
    tr.append(el('td', { style: { fontWeight: '700', color: ded > 0 ? 'var(--danger)' : 'var(--ink-3)' } },
      ded > 0 ? deduction(ded) : '—'));
    dbody.append(tr);
  }
  dtable.append(dbody);
  dwrap.append(dtable);
  box.append(dwrap);

  return box;
}

function addDeduction(person, year, month, onSaved) {
  const body = el('div', { style: { display: 'grid', gap: '10px' } });
  body.append(el('p.small.muted',
    `A one-off charge for ${person.full_name} in ${MONTHS[month]} ${year}. `
    + 'Re-using the same name later edits this deduction instead of adding a second one.'));
  const label = el('input.input', { placeholder: 'What is it for? e.g. Salary advance' });
  const amount = el('input.input', { type: 'number', min: '0', step: '10', placeholder: 'Amount in EGP' });
  const note = el('input.input', { placeholder: 'Note (optional)' });
  body.append(label, amount, note);
  modal({
    title: 'Add a deduction',
    body,
    actions: [
      { label: 'Cancel', cls: 'btn--pill-line' },
      { label: 'Add deduction', cls: 'btn--primary', onClick: async (close) => {
        if (!label.value.trim()) return toastErr('Give the deduction a name');
        const v = Number(amount.value);
        if (!Number.isFinite(v) || v < 0) return toastErr('Enter an amount of 0 or more');
        try {
          await Payroll.setDeduction(person.id, year, month, label.value.trim(), v, note.value.trim() || null);
          close(); toastOk('Deduction saved'); onSaved?.();
        } catch (e) { toastErr(e.message); }
      } },
    ],
  });
}

// ---- pieces ---------------------------------------------------------------
const sum = (list, f) => list.reduce((s, x) => s + Number(f(x) || 0), 0);
const modeLabel = (m) => (m === 'per_occurrence' ? 'per permission' : m === 'fixed' ? 'per month' : 'per minute');

function kpi(ic, tone, value, label) {
  const c = el('div.kpi');
  c.append(el('div.ic.ic--' + tone, { html: icon(ic) }));
  c.append(el('div', el('div.v', { style: { fontSize: '17px' } }, value), el('div.k', label)));
  return c;
}
function num(v, strong) { return el('td', { style: { whiteSpace: 'nowrap', fontWeight: strong ? '700' : '600' } }, v); }
function money(v, strong) {
  const n = Number(v || 0);
  return el('td', { style: { whiteSpace: 'nowrap', fontWeight: strong ? '700' : '600', color: n > 0 ? 'var(--danger)' : 'var(--ink-3)' } },
    n > 0 ? deduction(n) : '—');
}
function loadingRow() {
  const tb = el('tbody'); const tr = el('tr'); const td = el('td', { colspan: '15' });
  td.append(el('div.center-text.muted.small', { style: { padding: '20px' } }, 'Calculating payroll…'));
  tr.append(td); tb.append(tr); return tb;
}
function bigStat(label, value, color) {
  const t = el('div.stat');
  t.append(el('div.v', { style: { fontSize: '17px', color: color || null } }, value), el('div.k', label));
  return t;
}
function kv(k, v) {
  const r = el('div.row.between', { style: { gap: '12px' } });
  r.append(el('span.tiny.muted', k), el('span.tiny.b', { style: { textAlign: 'right' } }, v));
  return r;
}
function countPill(cls, text) { return el('span.pill.pill--' + cls, { style: { height: '26px' } }, text); }
function reasonHead(title, total) {
  const r = el('div.row.between', { style: { padding: '10px 0 4px', gap: '10px' } });
  r.append(el('span.small.b', title), el('span.small.b', { style: { color: 'var(--danger)' } }, total));
  return r;
}
function reasonRow(when, why, amount) {
  const r = el('div.lrow', { style: { gap: '10px' } });
  r.append(el('div.grow', el('div.name', when), el('div.meta', why)));
  r.append(el('div.small.b', { style: { color: 'var(--danger)', whiteSpace: 'nowrap' } }, amount));
  return r;
}
