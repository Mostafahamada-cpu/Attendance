import { Profiles, Attendance, OffDays, Balances, SalaryRules, Shifts, Permissions } from '../../lib/data.js?v=20260903a';
import { el, icon, avatar, pill, emptyState } from '../../lib/ui.js?v=20260903a';
import { toastOk, toastErr } from '../../lib/toast.js?v=20260903a';
import { ymd, todayYMD, fmtShortDate, fmtHM, minToHM, minToDur, MONTHS, DOW } from '../../lib/time.js?v=20260903a';
import { egp, hm12, mins } from '../../lib/money.js?v=20260903a';
import { editVacationBalance, LEAVE_TYPES } from './balances.js?v=20260903a';
import { editRules } from './salary-rules.js?v=20260903a';

export default async function adminEmployees({ refresh } = {}) {
  const people = (await Profiles.all()).filter(p => p.role === 'employee');
  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Employees'),
    el('p.muted.small', 'Select an employee to inspect their attendance, or give them manager rights to approve leave')));

  const search = el('div.input-icon', { style: { marginBottom: '18px', maxWidth: '360px' } });
  search.innerHTML = `<span class="i-lead">${icon('search')}</span>`;
  const sInput = el('input.input', { placeholder: 'Search employees…' });
  search.append(sInput);
  screen.append(search);

  const grid = el('div', { style: { display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))' } });
  screen.append(grid);

  function drawList(q = '') {
    grid.replaceChildren();
    const rows = people.filter(p => (p.full_name || '').toLowerCase().includes(q.toLowerCase()) || (p.department || '').toLowerCase().includes(q.toLowerCase()));
    if (!rows.length) { grid.append(el('div.card', emptyState('users', 'No employees found'))); return; }
    for (const p of rows) {
      const c = el('button.card.row', { style: { gap: '12px', textAlign: 'left', width: '100%', cursor: 'pointer' } });
      const info = el('div.grow');
      info.append(el('div.row', { style: { gap: '7px' } },
        el('span.b', p.full_name),
        p.is_manager ? el('span.pill.pill--working', { style: { height: '20px', fontSize: '10.5px', padding: '0 8px' } }, 'Manager') : null));
      info.append(el('div.tiny.muted', `${p.position || 'Employee'} · ${p.department || 'General'}`));
      c.append(avatar(p, 'sm'), info, iconSpan('chevR'));
      c.addEventListener('click', () => openDetail(p));
      grid.append(c);
    }
  }

  async function openDetail(p) {
    // The scrim is position:fixed, so it must be a child of <body>. Mounting it
    // inside the page would trap it: the screen's .fade-up wrapper keeps its
    // animated transform (animation-fill-mode: both), and a transformed element
    // becomes the containing block for fixed descendants — which clipped a tall
    // detail panel off the top of the window with no way to scroll to it.
    document.querySelectorAll('.emp-detail-scrim').forEach(n => n.remove());
    const modalScrim = el('div.modal-scrim.emp-detail-scrim', { style: { placeItems: 'center' } });
    const panel = el('div.modal', { style: { maxWidth: '640px', maxHeight: '88vh', overflowY: 'auto', borderRadius: 'var(--r-xl)' } });
    const close = () => { modalScrim.remove(); window.removeEventListener('hashchange', close); };
    // It now outlives the route's DOM, so tie it to navigation explicitly.
    window.addEventListener('hashchange', close);
    modalScrim.addEventListener('click', e => { if (e.target === modalScrim) close(); });

    const head = el('div.row', { style: { gap: '14px', marginBottom: '18px' } });
    head.append(avatar(p, 'lg'), el('div.grow', el('div', { style: { fontSize: '18px', fontWeight: '800' } }, p.full_name), el('div.small.muted', `${p.position || 'Employee'} · ${p.department || 'General'}`), el('div.tiny.muted', p.email || '')));
    const x = el('button.cal-nav', { html: icon('x'), style: { flex: 'none' } });
    x.firstChild && (x.style.width = '38px');
    x.addEventListener('click', close);
    head.append(x);
    panel.append(head);

    panel.append(el('div.center-text.muted.small', 'Loading attendance…'));
    modalScrim.append(panel);
    document.body.append(modalScrim);

    const now = new Date();
    const [recs, off, bal, rules, shifts, perms] = await Promise.all([
      Attendance.forMonth(p.id, now.getFullYear(), now.getMonth()),
      OffDays.mine(p.id),
      Balances.forEmployee(p.id).catch(() => []),
      SalaryRules.forEmployee(p.id).catch(() => null),   // pre-v7 database
      Shifts.all().catch(() => []),
      Permissions.forMonth(p.id, now.getFullYear(), now.getMonth()).catch(() => []),
    ]);
    panel.lastChild.remove();

    // Stats this month
    const present = recs.length;
    const totalMin = recs.reduce((s, r) => s + (r.total_minutes || 0), 0);
    const offSet = new Set(off.map(o => o.day_of_week));
    const workdays = countWorkdays(now.getFullYear(), now.getMonth(), offSet, todayYMD());
    const absent = Math.max(0, workdays - present);

    // ── Manager rights ───────────────────────────────────────────────────
    //  A manager is still an ordinary employee — they clock in and take leave
    //  as normal — but they also fill the manager slot on leave approvals.
    const mgrRow = el('div.row.between', {
      style: { padding: '13px 15px', background: 'var(--surface-2)', borderRadius: 'var(--r)', marginBottom: '18px', gap: '12px' },
    });
    mgrRow.append(el('div.grow',
      el('div.small.b', 'Manager rights'),
      el('div.tiny.muted', 'Can review and approve leave requests')));
    mgrRow.append(managerToggle(p));
    panel.append(mgrRow);

    // ── Vacation balance ─────────────────────────────────────────────────
    //  Read-only figures straight from ta_leave_balances; the button opens the
    //  same Edit Vacation Balance dialog the Vacation Balances screen uses, so
    //  there is one code path and one set of guard rails.
    panel.append(vacationCard(p, bal, close, refresh));

    // ── Salary & attendance rules ────────────────────────────────────────
    //  Read-only here; the button opens the same dialog the Salary & Rules
    //  screen uses, so there is one code path and one set of guard rails.
    if (rules) panel.append(rulesCard(p, rules, shifts, offSet, close, refresh));

    const stats = el('div.stat-3', { style: { marginBottom: '18px' } });
    stats.append(mini('Present', present), mini('Absent', absent), mini('Avg Hrs', recs.length ? minToHM(totalMin / recs.length) : '00:00'));
    panel.append(el('div.card-sub.b', { style: { marginBottom: '8px' } }, `${MONTHS[now.getMonth()]} ${now.getFullYear()}`), stats);

    // Weekly pattern (avg minutes per weekday)
    panel.append(el('div.section-h', el('h2', { style: { fontSize: '15px' } }, 'Weekly Pattern')));
    panel.append(weeklyPattern(recs, offSet));

    // History list — an approved leave permission is shown on the day it
    // belongs to, so authorised time out is never mistaken for a short day.
    const permsByDate = {};
    for (const lp of perms) {
      if (lp.status !== 'approved') continue;
      (permsByDate[lp.permission_date] ||= []).push(lp);
    }

    panel.append(el('div.section-h', el('h2', { style: { fontSize: '15px' } }, 'Recent History')));
    if (!recs.length) panel.append(emptyState('calendar', 'No records this month'));
    else {
      const list = el('div.list');
      [...recs].reverse().slice(0, 12).forEach(r => {
        const row = el('div.lrow');
        const lps = permsByDate[r.work_date] || [];
        const meta = el('div.meta', `${fmtHM(r.clock_in)} – ${r.clock_out ? fmtHM(r.clock_out) : '—'}`
          + (lps.length ? ` · permission ${lps.map(l => `${hm12(l.start_time)}–${hm12(l.end_time)}`).join(', ')}` : ''));
        row.append(el('div.grow', el('div.name', fmtShortDate(r.work_date)), meta));
        row.append(el('div.small.b', minToDur(r.total_minutes)));
        if (lps.length) {
          row.append(el('span.pill.pill--working', { style: { height: '22px' } },
            mins(lps.reduce((s, l) => s + l.duration_minutes, 0))));
        }
        row.append(pill(r.status === 'completed' ? 'present' : 'working'));
        list.append(row);
      });
      panel.append(list);
    }
  }

  sInput.addEventListener('input', () => drawList(sInput.value));
  drawList();
  return screen;
}

// Vacation balance panel — view the current allowance, and edit it.
//  `byType` folds the three ta_leave_balances rows into the shape the shared
//  editVacationBalance() dialog expects.
function vacationCard(p, bal, closeDetail, refresh) {
  const byType = {};
  for (const b of bal || []) byType[b.leave_type] = b;
  const total = (bal || []).reduce((s, b) => s + b.total_days, 0);
  const used = (bal || []).reduce((s, b) => s + b.used_days, 0);

  const card = el('div', {
    style: { padding: '13px 15px', background: 'var(--surface-2)', borderRadius: 'var(--r)', marginBottom: '18px' },
  });
  const head = el('div.row.between', { style: { gap: '12px', marginBottom: '10px' } });
  head.append(el('div.grow',
    el('div.small.b', 'Vacation balance'),
    el('div.tiny.muted', `${total - used} of ${total} day(s) remaining`)));
  const edit = el('button.btn.btn--primary.btn--sm', { style: { flex: 'none' } }, 'Edit Vacation Balance');
  // Close the drill-down first: the dialog sits above it, and after saving we
  // re-render the whole screen so the new figures are read back from the DB.
  edit.addEventListener('click', () => {
    closeDetail?.();
    editVacationBalance(p, byType, () => refresh?.());
  });
  head.append(edit);
  card.append(head);

  const grid = el('div.row.wrap', { style: { gap: '8px' } });
  for (const [key, label] of LEAVE_TYPES) {
    const b = byType[key];
    grid.append(el('span.pill.pill--present', { style: { height: '24px' } },
      `${label} ${b ? `${b.remaining_days}/${b.total_days}` : '—'}`));
  }
  card.append(grid);
  return card;
}

// Salary & attendance rules at a glance. The figures come straight from
// ta_salary_rules; the button opens the shared editRules() dialog, which is
// the only way any of them can change.
function rulesCard(p, rules, shifts, offSet, closeDetail, refresh) {
  const sh = shifts.find(s => s.id === rules.shift_id);
  const start = rules.shift_start_override || sh?.start_time;
  const end = rules.shift_end_override || sh?.end_time;

  const card = el('div', {
    style: { padding: '13px 15px', background: 'var(--surface-2)', borderRadius: 'var(--r)', marginBottom: '18px' },
  });
  const head = el('div.row.between', { style: { gap: '12px', marginBottom: '10px' } });
  head.append(el('div.grow',
    el('div.small.b', 'Salary & attendance rules'),
    el('div.tiny.muted', `${egp(rules.monthly_salary)} · ${sh?.name || 'Custom hours'} `
      + `${hm12(start)} – ${hm12(end)}`)));
  const edit = el('button.btn.btn--primary.btn--sm', { style: { flex: 'none' } }, 'Edit rules');
  edit.addEventListener('click', () => {
    closeDetail?.();
    editRules({ person: p, rules, shifts, off: offSet, onSaved: () => refresh?.() });
  });
  head.append(edit);
  card.append(head);

  const grid = el('div.row.wrap', { style: { gap: '8px' } });
  grid.append(
    el('span.pill.pill--present', { style: { height: '24px' } }, `${rules.grace_minutes} min grace`),
    el('span.pill.pill--present', { style: { height: '24px' } }, `${egp(rules.late_deduction_per_minute)} / late min`),
    el('span.pill.pill--present', { style: { height: '24px' } },
      rules.absence_basis === 'fixed_days' ? `Absence ÷ ${rules.absence_fixed_days} days` : 'Absence ÷ scheduled days'),
    el('span.pill.pill--present', { style: { height: '24px' } }, `${rules.permissions_per_month} permissions / month`),
    el('span.pill.pill--' + (rules.is_active === false ? 'denied' : 'approved'), { style: { height: '24px' } },
      rules.is_active === false ? 'Inactive' : 'Active'),
  );
  card.append(grid);
  return card;
}

// Toggling manager rights goes through ta_set_manager(): a database trigger
// rejects any non-admin trying to change role/is_manager directly.
function managerToggle(p) {
  let state = !!p.is_manager;
  const sw = el('div', { style: {
    width: '46px', height: '27px', borderRadius: '99px', padding: '3px', transition: 'background .2s',
    background: state ? 'var(--teal)' : 'var(--line)', cursor: 'pointer', flex: 'none' } });
  const knob = el('div', { style: { width: '21px', height: '21px', borderRadius: '50%', background: '#fff',
    transition: 'transform .2s', transform: state ? 'translateX(19px)' : 'none', boxShadow: '0 1px 3px rgba(0,0,0,.2)' } });
  sw.append(knob);
  const paint = () => {
    sw.style.background = state ? 'var(--teal)' : 'var(--line)';
    knob.style.transform = state ? 'translateX(19px)' : 'none';
  };
  sw.addEventListener('click', async () => {
    const next = !state;
    state = next; paint();
    try {
      await Profiles.setManager(p.id, next);
      p.is_manager = next;
      toastOk(next ? `${p.full_name.split(' ')[0]} can now approve leave` : `Manager rights removed from ${p.full_name.split(' ')[0]}`);
    } catch (e) {
      state = !next; paint();          // roll the switch back
      toastErr(e.message);
    }
  });
  return sw;
}

function iconSpan(name) { const s = el('span', { style: { color: 'var(--ink-3)' } }); s.innerHTML = icon(name); return s; }
function mini(label, value) { const t = el('div.stat'); t.innerHTML = `<div class="v">${value}</div><div class="k">${label}</div>`; return t; }

function countWorkdays(y, m, offSet, todayStr) {
  const daysIn = new Date(y, m + 1, 0).getDate();
  let n = 0;
  for (let d = 1; d <= daysIn; d++) {
    const date = ymd(new Date(y, m, d));
    if (date > todayStr) break;
    if (!offSet.has(new Date(y, m, d).getDay())) n++;
  }
  return n;
}

function weeklyPattern(recs, offSet) {
  const sum = Array(7).fill(0), cnt = Array(7).fill(0);
  for (const r of recs) { const d = new Date(r.work_date + 'T00:00:00').getDay(); sum[d] += r.total_minutes || 0; cnt[d]++; }
  const avg = sum.map((s, i) => cnt[i] ? s / cnt[i] : 0);
  const max = Math.max(...avg, 1);
  const chart = el('div.chart', { style: { marginBottom: '8px' } });
  for (let i = 0; i < 7; i++) {
    const bar = el('div.cbar');
    const fill = el('div.fill', { style: { height: (avg[i] / max * 100) + '%' } });
    if (offSet.has(i)) fill.style.background = 'var(--surface-2)';
    bar.append(fill, el('div.cl', DOW[i]));
    chart.append(bar);
  }
  return chart;
}
