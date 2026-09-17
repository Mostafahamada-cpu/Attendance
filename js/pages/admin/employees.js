// Admin → Employees — a Kanban board of employee cards.
//
// One round trip: ta_employee_board() returns, per employee, the same payroll
// summary the Payroll screen shows (rules, shift, THEIR off-days, the month so
// far) plus today's status, vacation balances and pending leave. Every figure
// on a card was priced by the database — a late arrival here costs exactly
// what it costs in Payroll and on the employee's own screen.
//
// Columns are today's attendance status. Cards carry a subtle colour that
// progresses across the roster (teal → blue → violet, by name order) so people
// are easy to tell apart at a glance; STATUS colours keep their meaning and
// come from the existing pill palette.
import { Profiles, Balances, SalaryRules, Shifts, OffDays, Payroll, LateTiers } from '../../lib/data.js?v=20260917a';
import { el, icon, avatar, pill, emptyState } from '../../lib/ui.js?v=20260917a';
import { toastOk, toastErr } from '../../lib/toast.js?v=20260917a';
import { fmtDayMon, minToDur, MONTHS, DOW, DOW_FULL } from '../../lib/time.js?v=20260917a';
import { egp, deduction, hm12, mins, dayType, dayFraction, lateRuleSummary, lateReason, DEFAULT_LATE_TIERS } from '../../lib/money.js?v=20260917a';
import { editVacationBalance, LEAVE_TYPES } from './balances.js?v=20260917a';
import { editRules, editSalary } from './salary-rules.js?v=20260917a';

// Today's status → board column. Anything not scheduled today (their own day
// off, a holiday, approved leave…) lands in "Off today".
const COLUMNS = [
  { key: 'on_time', title: 'On time',        pill: 'present', hint: 'Clocked in within the free window' },
  { key: 'late',    title: 'Late',           pill: 'pending', hint: 'Clocked in after the free window' },
  { key: 'not_in',  title: 'Not clocked in', pill: 'plain',   hint: 'Scheduled today, no clock-in yet' },
  { key: 'off',     title: 'Off today',      pill: 'weekend', hint: 'Day off · holiday · vacation · rest day · permission' },
];
function columnFor(row) {
  const t = row.today?.type;
  if (row.rules?.is_active === false) return 'off';
  if (t === 'present') return 'on_time';
  if (t === 'late') return 'late';
  if (t === 'not_in' || t === 'absent') return 'not_in';
  return 'off';
}

export default async function adminEmployees({ refresh } = {}) {
  const now = new Date();
  const year = now.getFullYear(), month = now.getMonth();
  let includeInactive = false;
  let view = 'board';
  let rows = [];
  let boardError = null;

  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '18px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Employees'),
    el('p.muted.small', `Live status for today and ${MONTHS[month]} so far — salary, shift, off-days, leave and `
      + 'every deduction, priced by the same rules as Payroll. Open a card for the day-by-day detail.')));

  // ── Controls ──────────────────────────────────────────────────────────────
  const controls = el('div.row.wrap.between', { style: { gap: '12px', marginBottom: '16px' } });
  const search = el('div.input-icon', { style: { flex: '1 1 220px', maxWidth: '340px' } });
  search.innerHTML = `<span class="i-lead">${icon('search')}</span>`;
  const sInput = el('input.input', { placeholder: 'Search name, role or department…' });
  search.append(sInput);
  const right = el('div.row.wrap', { style: { gap: '10px' } });
  const seg = el('div.seg');
  [['board', 'Board'], ['grid', 'All cards']].forEach(([v, l]) => {
    const b = el('button' + (v === view ? '.on' : ''), l);
    b.addEventListener('click', () => { view = v; [...seg.children].forEach(x => x.classList.remove('on')); b.classList.add('on'); draw(); });
    seg.append(b);
  });
  const inactiveBtn = el('button.btn.btn--pill-line.btn--sm', 'Show inactive');
  inactiveBtn.addEventListener('click', () => {
    includeInactive = !includeInactive;
    inactiveBtn.textContent = includeInactive ? 'Hide inactive' : 'Show inactive';
    load();
  });
  right.append(seg, inactiveBtn);
  controls.append(search, right);
  screen.append(controls);

  const summary = el('div.board-summary');
  screen.append(summary);

  const host = el('div');
  screen.append(host);

  async function load() {
    host.replaceChildren(el('div.card.center-text.muted.small', { style: { padding: '24px' } }, 'Loading employees…'));
    boardError = null;
    try {
      rows = await Payroll.board(year, month, includeInactive);
    } catch (e) {
      // Pre-v8 database: fall back to plain profiles so the screen still works.
      boardError = e.message;
      const people = (await Profiles.all()).filter(p => p.role === 'employee');
      rows = people.map(p => ({ employee: p, rules: null, totals: null, today: null, balances: [], pending_leaves: 0 }));
    }
    // Colour progression: position in the name-sorted roster.
    rows.forEach((r, i) => { r.__hue = hueFor(i, rows.length); });
    draw();
  }

  function filtered() {
    const q = sInput.value.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => [r.employee.full_name, r.employee.department, r.employee.position]
      .some(v => (v || '').toLowerCase().includes(q)));
  }

  function draw() {
    const list = filtered();
    drawSummary(list);
    host.replaceChildren();
    if (boardError) {
      host.append(el('div.banner.banner--warn',
        el('span.bi', { html: icon('alert') }),
        el('div', el('div.small.b', 'Live status unavailable'),
          el('div.tiny', `${boardError}. Run db/schema-v8.sql to enable the board; cards show basic details until then.`))));
    }
    if (!list.length) { host.append(el('div.card', emptyState('users', 'No employees found'))); return; }

    if (view === 'grid') {
      const grid = el('div.emp-grid');
      for (const r of list) grid.append(card(r));
      host.append(grid);
      return;
    }

    const board = el('div.kanban');
    for (const col of COLUMNS) {
      const members = list.filter(r => columnFor(r) === col.key);
      const c = el('div.kanban-col.kanban-col--' + col.key);
      const head = el('div.kanban-head');
      head.append(el('span.pill.pill--' + col.pill, col.title), el('span.kanban-count', String(members.length)));
      c.append(head, el('div.tiny.muted.kanban-hint', col.hint));
      const body = el('div.kanban-body');
      if (!members.length) body.append(el('div.kanban-empty', 'Nobody'));
      for (const r of members) body.append(card(r));
      c.append(body);
      board.append(c);
    }
    host.append(board);
  }

  function drawSummary(list) {
    const n = (k) => list.filter(r => columnFor(r) === k).length;
    const ded = list.reduce((s, r) => s + Number(r.totals?.total_deductions || 0), 0);
    summary.replaceChildren(
      stat('users', 'teal', String(list.length), 'Employees'),
      stat('checkcircle', 'teal', String(n('on_time')), 'On time today'),
      stat('clock', 'warn', String(n('late')), 'Late today'),
      stat('alert', 'danger', String(n('not_in')), 'Not clocked in'),
      stat('minus', 'danger', egp(ded), `Deductions · ${MONTHS[month].slice(0, 3)}`),
    );
  }

  // ── One employee card ─────────────────────────────────────────────────────
  function card(r) {
    const p = r.employee, rules = r.rules, t = r.totals, today = r.today;
    const c = el('article.emp-card', { tabindex: '0', role: 'button', 'aria-label': `${p.full_name} — open details` });
    c.style.setProperty('--emp-h', String(r.__hue));

    // Head
    const head = el('div.emp-head');
    const av = avatar(p, 'sm');
    av.style.background = `linear-gradient(135deg, hsl(${r.__hue} 55% 50%), hsl(${r.__hue + 28} 55% 58%))`;
    const who = el('div.grow', { style: { minWidth: '0' } });
    const nameLine = el('div.row', { style: { gap: '6px' } }, el('span.emp-name', p.full_name));
    if (p.is_manager) nameLine.append(tag('Manager', 'working'));
    if (rules?.is_active === false) nameLine.append(tag('Inactive', 'denied'));
    who.append(nameLine, el('div.tiny.muted.ellipsis', `${p.position || 'Employee'} · ${p.department || 'General'}`));
    head.append(av, who);
    c.append(head);

    // Today's status
    c.append(statusLine(r));

    // Facts
    const facts = el('div.emp-facts');
    const salaryVal = el('button.salary-edit', { title: 'Edit salary', 'aria-label': `Edit ${p.full_name}'s salary` });
    salaryVal.append(el('span.b', rules ? egp(rules.monthly_salary) : '—'), iconEl('edit'));
    salaryVal.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!rules) return toastErr('Salary rules are not available yet');
      editSalary({ person: p, salary: rules.monthly_salary, onSaved: () => load() });
    });
    facts.append(fact('Salary', salaryVal));
    facts.append(fact('Shift', rules
      ? el('div', el('div.small.b', rules.shift_name), el('div.tiny.muted', `${hm12(rules.shift_start)} – ${hm12(rules.shift_end)}`))
      : '—'));
    const offChips = el('div.row.wrap', { style: { gap: '4px' } });
    const off = rules?.off_days || [];
    if (!off.length) offChips.append(el('span.tiny.muted', rules ? 'None set' : '—'));
    for (const d of off) offChips.append(el('span.pill.pill--weekend.pill--xs', DOW[d]));
    facts.append(fact('Off-days', offChips));
    facts.append(fact(`Net · ${MONTHS[month].slice(0, 3)}`, t
      ? el('span.b', { style: { color: 'var(--teal-700)' } }, egp(t.net_salary)) : '—'));
    c.append(facts);

    // Leave & permissions
    const bal = r.balances || [];
    const balTotal = bal.reduce((s, b) => s + Number(b.total || 0), 0);
    const balLeft = bal.reduce((s, b) => s + Number(b.remaining || 0), 0);
    const pu = r.permission_usage;
    const leave = el('div.emp-leave');
    leave.append(chip('coffee', bal.length ? `Vacation ${balLeft}/${balTotal}` : 'Vacation —', 'approved'));
    leave.append(chip('clock', pu ? `Permissions ${pu.used}/${pu.limit}` : 'Permissions —',
      pu && pu.remaining === 0 ? 'pending' : 'working'));
    if (r.pending_leaves > 0) leave.append(chip('inbox', `${r.pending_leaves} pending leave`, 'pending'));
    c.append(leave);

    // Month indicators
    if (t) {
      const ind = el('div.emp-ind');
      ind.append(indicator(String(t.days_present), 'present', 'ok'));
      ind.append(indicator(String(t.late_days), 'late', t.late_days > 0 ? 'warn' : 'muted'));
      ind.append(indicator(String(t.absence_days), 'absent', t.absence_days > 0 ? 'danger' : 'muted'));
      ind.append(indicator(t.total_deductions > 0 ? deduction(t.total_deductions) : '—', 'deducted',
        t.total_deductions > 0 ? 'danger' : 'muted'));
      c.append(ind);
    }

    const open = () => openDetail(p, r);
    c.addEventListener('click', open);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return c;
  }

  // The line under the name: what the employee is doing right now.
  function statusLine(r) {
    const d = r.today, att = r.attendance_today, rules = r.rules;
    const line = el('div.emp-status');
    if (rules?.is_active === false) { line.append(pill('weekend'), el('span.tiny.muted.emp-status-t', 'Inactive employee')); return line; }
    if (!d) { line.append(el('span.pill.pill--plain', 'No data')); return line; }
    const meta = dayType(d.type);
    const working = att && !att.clock_out;
    let text = '';
    if (d.type === 'present' || d.type === 'late') {
      text = `In ${hm12(d.clock_in_local)}`;
      if (att?.clock_out) text += ` · out ${hm12(d.clock_out_local)} · ${mins(d.worked_minutes)}`;
      else if (working) text += ` · working ${minToDur(Math.max(0, Math.round((Date.now() - new Date(att.clock_in)) / 60000)))}`;
      if (d.type === 'late') text += ` · ${d.late_minutes} min late → ${d.late_label}`
        + (Number(d.late_days) > 0 ? ` (−${dayFraction(d.late_days)})` : '');
      else if (d.late_minutes > 0) text += ` · ${d.late_minutes} min, within grace`;
    } else if (d.type === 'not_in') {
      text = `Shift ${hm12(rules?.shift_start)} – ${hm12(rules?.shift_end)}`;
    } else if (d.type === 'absent') {
      text = `No clock-in · ${deduction(d.deduction)}`;
    } else if (d.type === 'weekly_off') {
      text = `${DOW_FULL[d.dow]} is their day off`;
    } else if (d.type === 'holiday') {
      text = d.holiday || 'Company holiday';
    } else if (d.type === 'leave') {
      text = `Approved ${d.leave_type || ''} leave`;
    } else if (d.type === 'permission') {
      text = `Permission covers the whole shift`;
    } else if (d.type === 'rest_day') {
      text = 'Approved rest day';
    }
    line.append(el('span.pill.pill--' + meta.pill,
      d.type === 'present' && working ? 'Working' : d.type === 'present' && att?.clock_out ? 'Done' : meta.label));
    if (text) line.append(el('span.tiny.muted.emp-status-t', text));
    return line;
  }

  // ── Detail drill-down ─────────────────────────────────────────────────────
  async function openDetail(p, boardRow) {
    // The scrim is position:fixed, so it must be a child of <body> — the
    // page's .fade-up keeps a transform and would clip a tall panel.
    document.querySelectorAll('.emp-detail-scrim').forEach(n => n.remove());
    const modalScrim = el('div.modal-scrim.emp-detail-scrim', { style: { placeItems: 'center' } });
    const panel = el('div.modal', { style: { maxWidth: '680px', maxHeight: '88vh', overflowY: 'auto', borderRadius: 'var(--r-xl)' } });
    const close = () => { modalScrim.remove(); window.removeEventListener('hashchange', close); };
    window.addEventListener('hashchange', close);
    modalScrim.addEventListener('click', e => { if (e.target === modalScrim) close(); });

    const head = el('div.row', { style: { gap: '14px', marginBottom: '18px' } });
    const av = avatar(p, 'lg');
    if (boardRow?.__hue != null) av.style.background = `linear-gradient(135deg, hsl(${boardRow.__hue} 55% 50%), hsl(${boardRow.__hue + 28} 55% 58%))`;
    head.append(av, el('div.grow', el('div', { style: { fontSize: '18px', fontWeight: '800' } }, p.full_name),
      el('div.small.muted', `${p.position || 'Employee'} · ${p.department || 'General'}`), el('div.tiny.muted', p.email || '')));
    const x = el('button.cal-nav', { html: icon('x'), style: { flex: 'none', width: '38px' } });
    x.addEventListener('click', close);
    head.append(x);
    panel.append(head);
    panel.append(el('div.center-text.muted.small', 'Loading…'));
    modalScrim.append(panel);
    document.body.append(modalScrim);

    const [pay, bal, rules, shifts, off, tiers] = await Promise.all([
      Payroll.forEmployee(p.id, year, month).catch(() => null),
      Balances.forEmployee(p.id).catch(() => []),
      SalaryRules.forEmployee(p.id).catch(() => null),
      Shifts.all().catch(() => []),
      OffDays.mine(p.id).catch(() => []),
      LateTiers.all().catch(() => null),
    ]);
    panel.lastChild.remove();
    const offSet = new Set(off.map(o => o.day_of_week));
    const reload = () => { close(); load(); };

    // ── Manager rights ───────────────────────────────────────────────────
    const mgrRow = el('div.row.between', {
      style: { padding: '13px 15px', background: 'var(--surface-2)', borderRadius: 'var(--r)', marginBottom: '14px', gap: '12px' } });
    mgrRow.append(el('div.grow', el('div.small.b', 'Manager rights'), el('div.tiny.muted', 'Can review and approve leave requests')));
    mgrRow.append(managerToggle(p));
    panel.append(mgrRow);

    // ── Salary, shift, off-days, late rule ───────────────────────────────
    if (rules) panel.append(rulesCard(p, rules, shifts, offSet, pay?.rules, tiers || DEFAULT_LATE_TIERS, reload));

    // ── Vacation balance ─────────────────────────────────────────────────
    panel.append(vacationCard(p, bal, reload));

    // ── The month, priced by ta_payroll() ────────────────────────────────
    panel.append(el('div.card-sub.b', { style: { marginBottom: '8px' } }, `${MONTHS[month]} ${year}`));
    if (!pay) {
      panel.append(el('p.tiny.muted', 'Payroll figures are unavailable (run db/schema-v8.sql).'));
    } else {
      const t = pay.totals;
      const stats = el('div.stat-4', { style: { marginBottom: '14px' } });
      stats.append(mini('Present', t.days_present), mini('Late', t.late_days), mini('Absent', t.absence_days),
        mini('Deducted', t.total_deductions > 0 ? deduction(t.total_deductions) : '—', t.total_deductions > 0 ? 'var(--danger)' : null));
      panel.append(stats);
      panel.append(el('p.tiny.muted', { style: { marginBottom: '14px' } },
        `${t.working_days} scheduled working day(s) after their ${offSet.size} weekly off-day(s) · `
        + `daily rate ${egp(t.daily_rate)} · net so far ${egp(t.net_salary)}`));

      panel.append(el('div.section-h', el('h2', { style: { fontSize: '15px' } }, 'Weekly Pattern')));
      panel.append(weeklyPattern(pay.days, offSet));

      panel.append(el('div.section-h', el('h2', { style: { fontSize: '15px' } }, 'Day by day')));
      const shown = pay.days.filter(d => d.type !== 'upcoming' && d.type !== 'not_in').reverse();
      if (!shown.length) panel.append(emptyState('calendar', 'Nothing recorded yet this month'));
      else {
        const list = el('div.list');
        for (const d of shown.slice(0, 31)) {
          const meta = dayType(d.type);
          const row = el('div.lrow');
          let sub;
          if (d.type === 'late') sub = lateReason(d, pay.rules);
          else if (d.clock_in_local) sub = `${hm12(d.clock_in_local)} – ${d.clock_out_local ? hm12(d.clock_out_local) : '—'}`
            + (d.worked_minutes ? ` · ${mins(d.worked_minutes)}` : '') + (d.late_minutes ? ` · ${d.late_minutes} min, within grace` : '');
          else if (d.type === 'absent') sub = `scheduled day, no attendance · ${egp(pay.totals.daily_rate)} daily rate`;
          else sub = d.holiday || (d.type === 'weekly_off' ? `${DOW_FULL[d.dow]} off` : meta.label);
          if (d.permission_minutes) sub += ` · permission ${mins(d.permission_minutes)}`;
          row.append(el('div.grow', el('div.name', `${fmtDayMon(d.date)} · ${DOW[d.dow]}`), el('div.meta', sub)));
          const ded = Number(d.deduction || 0) + Number(d.permission_deduction || 0);
          if (ded > 0) row.append(el('div.small.b', { style: { color: 'var(--danger)', whiteSpace: 'nowrap' } }, deduction(ded)));
          row.append(el('span.pill.pill--' + meta.pill, d.holiday ? 'Holiday' : meta.label));
          list.append(row);
        }
        panel.append(list);
      }
    }
  }

  sInput.addEventListener('input', draw);
  await load();
  return screen;
}

// ── Cards inside the drill-down ──────────────────────────────────────────────

// Salary & rules at a glance, with the quick salary edit and the full dialog.
function rulesCard(p, rules, shifts, offSet, payRules, tiers, onSaved) {
  const sh = shifts.find(s => s.id === rules.shift_id);
  const start = rules.shift_start_override || sh?.start_time;
  const end = rules.shift_end_override || sh?.end_time;
  const card = el('div', { style: { padding: '13px 15px', background: 'var(--surface-2)', borderRadius: 'var(--r)', marginBottom: '14px' } });

  const head = el('div.row.between', { style: { gap: '12px', marginBottom: '10px' } });
  const salary = el('button.salary-edit', { title: 'Edit salary' });
  salary.append(el('span', { style: { fontSize: '18px', fontWeight: '800' } }, egp(rules.monthly_salary)), iconEl('edit'));
  salary.addEventListener('click', () => editSalary({ person: p, salary: rules.monthly_salary, onSaved }));
  head.append(el('div.grow', el('div.tiny.muted', 'Monthly salary'), salary));
  const edit = el('button.btn.btn--pill-line.btn--sm', { style: { flex: 'none' } }, 'Edit all rules');
  edit.addEventListener('click', () => editRules({ person: p, rules, shifts, off: offSet, tiers, onSaved }));
  head.append(edit);
  card.append(head);

  const grid = el('div', { style: { display: 'grid', gap: '5px' } });
  grid.append(
    kv('Shift', `${sh?.name || 'Custom hours'} · ${hm12(start)} – ${hm12(end)}`),
    kv('Off-days', [...offSet].sort().map(d => DOW_FULL[d]).join(', ') || 'None set'),
    kv('Late arrivals', lateRuleSummary({ ...rules, late_tiers: payRules?.late_tiers || tiers })),
    kv('Absence', rules.absence_basis === 'fixed_days' ? `salary ÷ ${rules.absence_fixed_days} days` : 'salary ÷ scheduled days'),
    kv('Permissions', `${rules.permissions_per_month} / month`),
    kv('Status', rules.is_active === false ? 'Inactive' : 'Active'),
  );
  card.append(grid);
  return card;
}

function vacationCard(p, bal, onSaved) {
  const byType = {};
  for (const b of bal || []) byType[b.leave_type] = b;
  const total = (bal || []).reduce((s, b) => s + b.total_days, 0);
  const used = (bal || []).reduce((s, b) => s + b.used_days, 0);
  const card = el('div', { style: { padding: '13px 15px', background: 'var(--surface-2)', borderRadius: 'var(--r)', marginBottom: '18px' } });
  const head = el('div.row.between', { style: { gap: '12px', marginBottom: '10px' } });
  head.append(el('div.grow', el('div.small.b', 'Vacation balance'), el('div.tiny.muted', `${total - used} of ${total} day(s) remaining`)));
  const edit = el('button.btn.btn--pill-line.btn--sm', { style: { flex: 'none' } }, 'Edit balance');
  edit.addEventListener('click', () => editVacationBalance(p, byType, onSaved));
  head.append(edit);
  card.append(head);
  const grid = el('div.row.wrap', { style: { gap: '8px' } });
  for (const [key, label] of LEAVE_TYPES) {
    const b = byType[key];
    grid.append(el('span.pill.pill--present', { style: { height: '24px' } }, `${label} ${b ? `${b.remaining_days}/${b.total_days}` : '—'}`));
  }
  card.append(grid);
  return card;
}

// Toggling manager rights goes through ta_set_manager(): a database trigger
// rejects any non-admin trying to change role/is_manager directly.
function managerToggle(p) {
  let state = !!p.is_manager;
  const sw = el('div', { style: { width: '46px', height: '27px', borderRadius: '99px', padding: '3px', transition: 'background .2s',
    background: state ? 'var(--teal)' : 'var(--line)', cursor: 'pointer', flex: 'none' } });
  const knob = el('div', { style: { width: '21px', height: '21px', borderRadius: '50%', background: '#fff',
    transition: 'transform .2s', transform: state ? 'translateX(19px)' : 'none', boxShadow: '0 1px 3px rgba(0,0,0,.2)' } });
  sw.append(knob);
  const paint = () => { sw.style.background = state ? 'var(--teal)' : 'var(--line)'; knob.style.transform = state ? 'translateX(19px)' : 'none'; };
  sw.addEventListener('click', async () => {
    const next = !state; state = next; paint();
    try {
      await Profiles.setManager(p.id, next);
      p.is_manager = next;
      toastOk(next ? `${p.full_name.split(' ')[0]} can now approve leave` : `Manager rights removed from ${p.full_name.split(' ')[0]}`);
    } catch (e) { state = !next; paint(); toastErr(e.message); }
  });
  return sw;
}

// Average worked minutes per weekday, from the priced days.
function weeklyPattern(days, offSet) {
  const sum = Array(7).fill(0), cnt = Array(7).fill(0);
  for (const d of days || []) { if (d.worked_minutes > 0) { sum[d.dow] += d.worked_minutes; cnt[d.dow]++; } }
  const avg = sum.map((s, i) => cnt[i] ? s / cnt[i] : 0);
  const max = Math.max(...avg, 1);
  const chart = el('div.chart', { style: { marginBottom: '8px' } });
  for (let i = 0; i < 7; i++) {
    const bar = el('div.cbar', { title: offSet.has(i) ? `${DOW_FULL[i]} — day off` : `${DOW_FULL[i]}: ${minToDur(avg[i])}` });
    const fill = el('div.fill', { style: { height: (avg[i] / max * 100) + '%' } });
    if (offSet.has(i)) fill.style.background = 'var(--surface-2)';
    bar.append(fill, el('div.cl', DOW[i]));
    chart.append(bar);
  }
  return chart;
}

// ── Small pieces ──────────────────────────────────────────────────────────────
// Hue progression across the roster: teal (170) → blue → violet (290).
function hueFor(i, n) { return n <= 1 ? 190 : Math.round(170 + (i / (n - 1)) * 120); }
function tag(text, cls) { return el('span.pill.pill--' + cls + '.pill--xs', text); }
function iconEl(name) { const s = el('span.arr'); s.innerHTML = icon(name, 'ic-sm'); return s; }
function fact(label, value) {
  const f = el('div.emp-fact');
  f.append(el('div.emp-fact-k', label));
  f.append(value?.nodeType ? value : el('div.small.b', String(value)));
  return f;
}
function chip(ic, text, cls) {
  const c = el('span.pill.pill--' + cls + '.pill--xs.pill--nodot');
  c.innerHTML = icon(ic, 'ic-sm');
  c.append(document.createTextNode(text));
  return c;
}
function indicator(v, k, tone) {
  const i = el('div.emp-i.emp-i--' + tone);
  i.append(el('div.v', v), el('div.k', k));
  return i;
}
function stat(ic, tone, value, label) {
  const c = el('div.kpi.kpi--sm');
  c.append(el('div.ic.ic--' + tone, { html: icon(ic) }));
  c.append(el('div', el('div.v', value), el('div.k', label)));
  return c;
}
function mini(label, value, color) {
  const t = el('div.stat');
  t.append(el('div.v', { style: { color: color || null } }, String(value)), el('div.k', label));
  return t;
}
function kv(k, v) {
  const r = el('div.row.between', { style: { gap: '12px' } });
  r.append(el('span.tiny.muted', k), el('span.tiny.b', { style: { textAlign: 'right' } }, v));
  return r;
}
