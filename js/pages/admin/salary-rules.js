// Admin → Salary & Attendance Rules.
//
// Everything an employee's pay is derived from lives here: their salary, which
// shift they work, how long the grace period is, what a late minute costs, how
// an absent day is priced, how many leave permissions they get, and which days
// they are off.
//
// Nothing on this screen writes to a table directly. Every save goes through
// ta_set_salary_rules() / ta_set_shift() / ta_set_payroll_defaults(), which
// re-check that the caller is an admin and re-check every bound. The tables
// themselves have no write grants at all, so a crafted PostgREST call from the
// console is refused before RLS is even consulted.
import { Profiles, SalaryRules, Shifts, Settings, OffDays, Holidays, Payroll } from '../../lib/data.js?v=20260903a';
import { el, icon, avatar, emptyState } from '../../lib/ui.js?v=20260903a';
import { toastOk, toastErr, modal, confirmDialog } from '../../lib/toast.js?v=20260903a';
import { DOW, DOW_FULL, fmtShortDate, todayYMD } from '../../lib/time.js?v=20260903a';
import { egp, hm12, timeInputValue, ABSENCE_BASIS, PERMISSION_MODES } from '../../lib/money.js?v=20260903a';

export default async function adminSalaryRules({ refresh } = {}) {
  const [people, rules, shifts, cfg, holidays] = await Promise.all([
    Profiles.all(),
    SalaryRules.all(),
    Shifts.all(),
    Settings.get().catch(() => null),
    Holidays.forYear(new Date().getFullYear()).catch(() => []),
  ]);

  // Weekly days off still live in ta_weekly_off_days — one read per person,
  // the same call the Off-Days screen makes.
  const offByEmp = {};
  await Promise.all(people.map(async (p) => {
    offByEmp[p.id] = new Set((await OffDays.mine(p.id).catch(() => [])).map(o => o.day_of_week));
  }));

  const rulesByEmp = Object.fromEntries(rules.map(r => [r.employee_id, r]));
  const shiftById = Object.fromEntries(shifts.map(s => [s.id, s]));

  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Salary & Attendance Rules'),
    el('p.muted.small', 'Set each employee\'s salary, work shift, grace period, deductions and weekly days off. '
      + 'Payroll is calculated from these rules and their attendance — nothing is charged twice.')));

  // ── Company defaults + shifts ─────────────────────────────────────────────
  const top = el('div', { style: {
    display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', marginBottom: '18px' } });
  top.append(defaultsCard(cfg, refresh), shiftsCard(shifts, refresh));
  screen.append(top);

  // ── Holidays ──────────────────────────────────────────────────────────────
  screen.append(holidaysCard(holidays, refresh));

  // ── Employees ─────────────────────────────────────────────────────────────
  screen.append(el('div.section-h', { style: { marginTop: '24px' } }, el('h2', 'Employee rules')));

  const controls = el('div.row.wrap', { style: { gap: '12px', marginBottom: '14px' } });
  const search = el('div.input-icon', { style: { maxWidth: '300px', flex: '1' } });
  search.innerHTML = `<span class="i-lead">${icon('search')}</span>`;
  const sInput = el('input.input', { placeholder: 'Search employees…' });
  search.append(sInput);
  let flt = 'active';
  const seg = el('div.seg');
  [['active', 'Active'], ['inactive', 'Inactive'], ['all', 'All']].forEach(([v, l]) => {
    const b = el('button' + (v === flt ? '.on' : ''), l);
    b.addEventListener('click', () => { flt = v; [...seg.children].forEach(x => x.classList.remove('on')); b.classList.add('on'); draw(); });
    seg.append(b);
  });
  controls.append(search, seg);
  screen.append(controls);

  const wrap = el('div.table-wrap');
  const table = el('table.tbl.tbl--wide');
  wrap.append(table);
  screen.append(wrap);

  screen.append(el('p.tiny.muted', { style: { marginTop: '12px' } },
    'Employees can see their own schedule, salary and deductions but can never edit them — '
    + 'the salary tables have no write permission over the API for anyone, including admins. '
    + 'All changes go through an admin-only database function.'));

  function draw() {
    const q = sInput.value.trim().toLowerCase();
    const list = people.filter((p) => {
      const r = rulesByEmp[p.id];
      const active = r ? r.is_active : true;
      if (flt === 'active' && !active) return false;
      if (flt === 'inactive' && active) return false;
      if (!q) return true;
      return [p.full_name, p.department, p.position].some(v => (v || '').toLowerCase().includes(q));
    });

    table.replaceChildren();
    const thead = el('thead');
    thead.innerHTML = '<tr><th>Employee</th><th>Role</th><th>Monthly salary</th><th>Shift</th>'
      + '<th>Grace</th><th>Late / min</th><th>Absence</th><th>Permissions</th><th>Days off</th><th>Status</th><th></th></tr>';
    table.append(thead);

    const tbody = el('tbody');
    if (!list.length) {
      const tr = el('tr'); const td = el('td', { colspan: '11' });
      td.append(emptyState('users', 'No employees match'));
      tr.append(td); tbody.append(tr);
    }
    for (const p of list) {
      const r = rulesByEmp[p.id] || {};
      const sh = shiftById[r.shift_id];
      const start = r.shift_start_override || sh?.start_time;
      const end = r.shift_end_override || sh?.end_time;
      const off = [...(offByEmp[p.id] || [])].sort();

      const tr = el('tr');

      const who = el('td');
      const line = el('div.row', { style: { gap: '10px' } });
      const nameLine = el('div.row', { style: { gap: '7px' } }, el('span.b', p.full_name));
      if (p.role === 'admin') nameLine.append(tag('Admin'));
      line.append(avatar(p, 'sm'), el('div', nameLine, el('div.tiny.muted', p.department || '—')));
      who.append(line);
      tr.append(who);

      tr.append(el('td.tiny', p.position || 'Employee'));
      tr.append(el('td', { style: { fontWeight: '700', whiteSpace: 'nowrap' } },
        egp(r.monthly_salary ?? cfg?.default_salary ?? 6000)));

      const shiftCell = el('td', { style: { whiteSpace: 'nowrap' } });
      shiftCell.append(el('div.small.b', sh?.name || 'Custom hours'));
      shiftCell.append(el('div.tiny.muted', `${hm12(start)} – ${hm12(end)}`
        + (r.shift_start_override || r.shift_end_override ? ' · custom' : '')));
      tr.append(shiftCell);

      tr.append(el('td.tiny', `${r.grace_minutes ?? cfg?.default_grace_minutes ?? 15} min`));
      tr.append(el('td.tiny', egp(r.late_deduction_per_minute ?? cfg?.default_late_per_minute ?? 1)));
      tr.append(el('td.tiny', r.absence_basis === 'fixed_days'
        ? `÷ ${r.absence_fixed_days} days` : '÷ scheduled days'));

      const permCell = el('td', { style: { whiteSpace: 'nowrap' } });
      permCell.append(el('div.small.b', `${r.permissions_per_month ?? 3} / month`));
      permCell.append(el('div.tiny.muted', r.permission_deduction_enabled
        ? `deducts ${egp(r.permission_deduction_rate)} ${modeShort(r.permission_deduction_mode)}`
        : 'no deduction'));
      tr.append(permCell);

      const offCell = el('td');
      const chips = el('div.row.wrap', { style: { gap: '4px' } });
      if (!off.length) chips.append(el('span.tiny.muted', 'None'));
      for (const d of off) chips.append(el('span.pill.pill--weekend', { style: { height: '22px', fontSize: '10.5px', padding: '0 8px' } }, DOW[d]));
      offCell.append(chips);
      tr.append(offCell);

      tr.append(el('td', el('span.pill.pill--' + (r.is_active === false ? 'denied' : 'approved'),
        r.is_active === false ? 'Inactive' : 'Active')));

      const act = el('td');
      const b = el('button.btn.btn--pill-line.btn--sm', 'Edit rules');
      b.addEventListener('click', () => editRules({
        person: p, rules: r, shifts, off: offByEmp[p.id] || new Set(), cfg, onSaved: refresh,
      }));
      act.append(b);
      tr.append(act);

      tbody.append(tr);
    }
    table.append(tbody);
  }

  sInput.addEventListener('input', draw);
  draw();
  return screen;
}

const modeShort = (m) => (m === 'per_occurrence' ? 'per permission' : m === 'fixed' ? 'per month' : 'per minute');
function tag(text) {
  return el('span.pill.pill--working', { style: { height: '20px', fontSize: '10.5px', padding: '0 8px' } }, text);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Company defaults — timezone and what a NEW employee inherits
// ─────────────────────────────────────────────────────────────────────────────
function defaultsCard(cfg, onSaved) {
  const card = el('div.card');
  card.append(el('div.card-title', 'Company defaults'));
  card.append(el('p.tiny.muted', { style: { marginBottom: '14px' } },
    'The timezone every shift comparison uses, and the rules a newly added employee starts with. '
    + 'Changing these does not rewrite anyone\'s existing rules.'));

  const tz = field('Timezone', el('input.input', { value: cfg?.timezone || 'Africa/Cairo', placeholder: 'Africa/Cairo' }),
    'Lateness is judged in this zone, never in the browser\'s.');
  const salary = field('Default monthly salary', numInput(cfg?.default_salary ?? 6000, { min: 0, step: '50' }), 'EGP');
  const grace = field('Default grace period', numInput(cfg?.default_grace_minutes ?? 15, { min: 0, max: 240 }), 'minutes');
  const rate = field('Default late deduction', numInput(cfg?.default_late_per_minute ?? 1, { min: 0, step: '0.25' }), 'EGP per minute past the grace');
  const perms = field('Leave permissions', numInput(cfg?.permissions_per_month ?? 3, { min: 0, max: 31 }), 'auto-approved per calendar month');

  const grid = el('div', { style: { display: 'grid', gap: '10px' } });
  grid.append(tz.row, salary.row, grace.row, rate.row, perms.row);
  card.append(grid);

  const save = el('button.btn.btn--primary.btn--sm.btn--block', { style: { marginTop: '14px' } }, 'Save defaults');
  save.addEventListener('click', async () => {
    save.disabled = true; save.textContent = 'Saving…';
    try {
      await Payroll.setDefaults({
        timezone: tz.input.value.trim() || null,
        salary: salary.input.value,
        grace: grace.input.value,
        latePerMinute: rate.input.value,
        permissions: perms.input.value,
      });
      toastOk('Company defaults saved');
      onSaved?.();
    } catch (e) { toastErr(e.message); }
    finally { save.disabled = false; save.textContent = 'Save defaults'; }
  });
  card.append(save);
  return card;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Work shifts
// ─────────────────────────────────────────────────────────────────────────────
function shiftsCard(shifts, onSaved) {
  const card = el('div.card');
  card.append(el('div.card-title', 'Work shifts'));
  card.append(el('p.tiny.muted', { style: { marginBottom: '14px' } },
    'Assign one of these to each employee. Their shift start is what lateness is measured against.'));

  const list = el('div', { style: { display: 'grid', gap: '10px' } });
  for (const s of shifts) {
    const row = el('div.row.between', {
      style: { gap: '10px', padding: '11px 13px', background: 'var(--surface-2)', borderRadius: 'var(--r)' } });
    row.append(el('div.grow',
      el('div.small.b', s.name),
      el('div.tiny.muted', `${hm12(s.start_time)} → ${hm12(s.end_time)}`)));
    const edit = el('button.btn.btn--pill-line.btn--sm', { style: { flex: 'none' } }, 'Edit');
    edit.addEventListener('click', () => editShift(s, onSaved));
    row.append(edit);
    list.append(row);
  }
  if (!shifts.length) list.append(emptyState('clock', 'No shifts yet', 'Run db/schema-v7.sql to create them.'));
  card.append(list);
  return card;
}

function editShift(s, onSaved) {
  const body = el('div', { style: { display: 'grid', gap: '10px' } });
  const name = field('Name', el('input.input', { value: s.name }));
  const start = field('Starts', el('input.input', { type: 'time', value: timeInputValue(s.start_time) }));
  const end = field('Ends', el('input.input', { type: 'time', value: timeInputValue(s.end_time) }));
  body.append(name.row, start.row, end.row);
  modal({
    title: 'Edit ' + s.name,
    body,
    actions: [
      { label: 'Cancel', cls: 'btn--pill-line' },
      { label: 'Save shift', cls: 'btn--primary', onClick: async (close) => {
        if (!start.input.value || !end.input.value) return toastErr('Set both a start and an end time');
        if (start.input.value === end.input.value) return toastErr('A shift cannot start and end at the same time');
        try {
          await Shifts.save(s.id, { name: name.input.value.trim(), start: start.input.value, end: end.input.value });
          close(); toastOk('Shift updated'); onSaved?.();
        } catch (e) { toastErr(e.message); }
      } },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Company holidays — a holiday is never an absence, for anyone
// ─────────────────────────────────────────────────────────────────────────────
function holidaysCard(holidays, onSaved) {
  const card = el('div.card');
  const head = el('div.row.between', { style: { gap: '12px', marginBottom: '6px' } });
  head.append(el('div.grow', el('div.card-title', { style: { marginBottom: '2px' } }, 'Company holidays'),
    el('p.tiny.muted', 'A holiday is not a working day, so it never counts as an absence and never costs anyone a deduction.')));
  const add = el('button.btn.btn--pill-line.btn--sm', { style: { flex: 'none' } }, 'Add holiday');
  add.addEventListener('click', () => addHoliday(onSaved));
  head.append(add);
  card.append(head);

  const chips = el('div.row.wrap', { style: { gap: '8px', marginTop: '12px' } });
  if (!holidays.length) chips.append(el('span.tiny.muted', 'No holidays set for this year.'));
  for (const h of holidays) {
    const chip = el('span.pill.pill--weekend', { style: { height: '30px', gap: '8px' } },
      `${fmtShortDate(h.holiday_date)} · ${h.name}`);
    const x = el('button', { style: { marginLeft: '6px', opacity: '.6' }, 'aria-label': 'Remove ' + h.name, html: icon('x', 'ic-sm') });
    x.addEventListener('click', () => confirmDialog({
      title: 'Remove holiday?',
      message: `${fmtShortDate(h.holiday_date)} — ${h.name} will count as a normal working day again.`,
      confirmLabel: 'Remove', danger: true,
      onConfirm: async () => {
        try { await Holidays.remove(h.holiday_date); toastOk('Holiday removed'); onSaved?.(); }
        catch (e) { toastErr(e.message); }
      },
    }));
    chip.append(x);
    chips.append(chip);
  }
  card.append(chips);
  return card;
}

function addHoliday(onSaved) {
  const body = el('div', { style: { display: 'grid', gap: '10px' } });
  const date = field('Date', el('input.input', { type: 'date', value: todayYMD() }));
  const name = field('Name', el('input.input', { placeholder: 'e.g. Eid al-Fitr' }));
  body.append(date.row, name.row);
  modal({
    title: 'Add a holiday',
    body,
    actions: [
      { label: 'Cancel', cls: 'btn--pill-line' },
      { label: 'Add holiday', cls: 'btn--primary', onClick: async (close) => {
        if (!date.input.value) return toastErr('Pick a date');
        try {
          await Holidays.set(date.input.value, name.input.value.trim() || 'Holiday');
          close(); toastOk('Holiday added'); onSaved?.();
        } catch (e) { toastErr(e.message); }
      } },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Edit one employee's rules
//  Exported so the Employees drill-down can open exactly the same dialog with
//  exactly the same guard rails.
// ─────────────────────────────────────────────────────────────────────────────
export function editRules({ person, rules = {}, shifts = [], off = new Set(), cfg = null, onSaved }) {
  const body = el('div');
  body.append(el('p.small.muted', { style: { marginBottom: '16px' } },
    `How ${person.full_name}'s attendance turns into pay. Saved to the database immediately; `
    + 'the figures on their own screen and in Payroll update from the same rules.'));

  const sections = el('div', { style: { display: 'grid', gap: '18px' } });

  // ── Pay ────────────────────────────────────────────────────────────────
  const salary = field('Monthly salary', numInput(rules.monthly_salary ?? cfg?.default_salary ?? 6000, { min: 0, step: '50' }), 'EGP');
  sections.append(group('Pay', [salary.row]));

  // ── Shift ──────────────────────────────────────────────────────────────
  const shiftSel = el('select.input');
  for (const s of shifts) {
    shiftSel.append(el('option', { value: s.id, selected: s.id === rules.shift_id || null },
      `${s.name} · ${hm12(s.start_time)} – ${hm12(s.end_time)}`));
  }
  if (!rules.shift_id) shiftSel.prepend(el('option', { value: '', selected: true }, 'No shift assigned'));
  const shiftRow = field('Work shift', shiftSel, 'Lateness is measured from this shift\'s start time.');

  const startOv = field('Custom start (optional)',
    el('input.input', { type: 'time', value: timeInputValue(rules.shift_start_override) }));
  const endOv = field('Custom end (optional)',
    el('input.input', { type: 'time', value: timeInputValue(rules.shift_end_override) }));
  const clearOv = checkbox('Reset to the shift\'s own hours', false);
  sections.append(group('Work shift', [shiftRow.row, startOv.row, endOv.row, clearOv.row]));

  // ── Weekly days off ────────────────────────────────────────────────────
  const picked = new Set(off);
  const chips = el('div.day-strip');
  for (let d = 0; d < 7; d++) {
    const chip = el('button.day-chip' + (picked.has(d) ? '.on' : ''), { title: DOW_FULL[d] }, DOW[d]);
    chip.addEventListener('click', () => {
      if (picked.has(d)) picked.delete(d); else picked.add(d);
      chip.classList.toggle('on', picked.has(d));
    });
    chips.append(chip);
  }
  const offHelp = el('p.tiny.muted', { style: { marginTop: '8px' } },
    'A selected day never counts as an absence. Sales normally take one day (Friday); '
    + 'developers and engineers take two (Friday + Saturday).');
  sections.append(group('Weekly days off', [chips, offHelp]));

  // ── Lateness ───────────────────────────────────────────────────────────
  const grace = field('Grace period', numInput(rules.grace_minutes ?? cfg?.default_grace_minutes ?? 15, { min: 0, max: 240 }),
    'minutes. Arriving within the grace is on time; the first billable minute is the one after it.');
  const perMin = field('Late deduction', numInput(rules.late_deduction_per_minute ?? cfg?.default_late_per_minute ?? 1, { min: 0, step: '0.25' }),
    'EGP for every minute past the grace period.');
  const cap = field('Daily cap (optional)', numInput(rules.late_deduction_cap_per_day ?? '', { min: 0, step: '10' }),
    'EGP. The most one late day can cost. Leave blank for no cap.');
  sections.append(group('Lateness', [grace.row, perMin.row, cap.row]));

  // ── Absence ────────────────────────────────────────────────────────────
  const basis = el('select.input');
  for (const [v, label] of Object.entries(ABSENCE_BASIS)) {
    basis.append(el('option', { value: v, selected: (rules.absence_basis || 'scheduled') === v || null }, label));
  }
  const basisRow = field('Daily rate is', basis, 'How the cost of one absent day is worked out.');
  const fixedDays = field('Days per month', numInput(rules.absence_fixed_days ?? 26, { min: 1, max: 31 }),
    'Used only with a fixed month length.');
  const mult = field('Multiplier', numInput(rules.absence_multiplier ?? 1, { min: 0, step: '0.5' }),
    '1 = one day\'s pay per absent day. 2 = double.');
  const syncBasis = () => { fixedDays.row.style.display = basis.value === 'fixed_days' ? '' : 'none'; };
  basis.addEventListener('change', syncBasis); syncBasis();
  sections.append(group('Absence', [basisRow.row, fixedDays.row, mult.row,
    el('p.tiny.muted', 'Approved vacation, approved rest days, weekly days off and company holidays are never absences.')]));

  // ── Leave permissions ──────────────────────────────────────────────────
  const permCount = field('Permissions per month', numInput(rules.permissions_per_month ?? cfg?.permissions_per_month ?? 3, { min: 0, max: 31 }),
    'Approved automatically. Anything beyond this waits for an admin.');
  const permOn = checkbox('Deduct pay for approved permissions', !!rules.permission_deduction_enabled);
  const permMode = el('select.input');
  for (const [v, label, hint] of PERMISSION_MODES) {
    permMode.append(el('option', { value: v, selected: (rules.permission_deduction_mode || 'per_minute') === v || null },
      `${label} — ${hint}`));
  }
  const permModeRow = field('Method', permMode);
  const permRate = field('Amount', numInput(rules.permission_deduction_rate ?? 0, { min: 0, step: '0.25' }), 'EGP');
  const syncPerm = () => {
    const on = permOn.input.checked;
    permModeRow.row.style.display = on ? '' : 'none';
    permRate.row.style.display = on ? '' : 'none';
  };
  permOn.input.addEventListener('change', syncPerm); syncPerm();
  sections.append(group('Leave permissions', [permCount.row, permOn.row, permModeRow.row, permRate.row,
    el('p.tiny.muted', 'Off by default — an approved permission costs nothing unless this is switched on.')]));

  // ── Status ─────────────────────────────────────────────────────────────
  const active = checkbox('Active employee', rules.is_active !== false);
  sections.append(group('Status', [active.row,
    el('p.tiny.muted', 'An inactive employee is hidden from Payroll by default and keeps every past record.')]));

  body.append(sections);

  modal({
    title: 'Rules · ' + person.full_name,
    body,
    actions: [
      { label: 'Cancel', cls: 'btn--pill-line' },
      {
        label: 'Save rules', cls: 'btn--primary',
        onClick: async (close) => {
          const salaryV = Number(salary.input.value);
          if (!Number.isFinite(salaryV) || salaryV < 0) return toastErr('Enter a monthly salary of 0 or more');
          const graceV = Number(grace.input.value);
          if (!Number.isInteger(graceV) || graceV < 0 || graceV > 240) return toastErr('The grace period must be 0–240 minutes');
          const rateV = Number(perMin.input.value);
          if (!Number.isFinite(rateV) || rateV < 0) return toastErr('The late deduction cannot be negative');
          if (!picked.size) return toastErr('Pick at least one weekly day off');
          if (picked.size > 6) return toastErr('An employee needs at least one working day');
          if (permOn.input.checked && !(Number(permRate.input.value) > 0)) {
            return toastErr('Set the permission deduction amount, or switch the deduction off');
          }
          try {
            await SalaryRules.save(person.id, {
              salary: salary.input.value,
              shiftId: shiftSel.value || null,
              grace: grace.input.value,
              latePerMinute: perMin.input.value,
              lateCap: cap.input.value,
              absenceBasis: basis.value,
              absenceFixedDays: fixedDays.input.value,
              absenceMultiplier: mult.input.value,
              offDays: [...picked].sort((a, b) => a - b),
              isActive: active.input.checked,
              shiftStart: startOv.input.value || null,
              shiftEnd: endOv.input.value || null,
              clearOverrides: clearOv.input.checked,
              permissionsPerMonth: permCount.input.value,
              permissionDeductionEnabled: permOn.input.checked,
              permissionDeductionMode: permMode.value,
              permissionDeductionRate: permRate.input.value,
            });
            close();
            toastOk(`Rules saved for ${person.full_name.split(' ')[0]}`);
            onSaved?.();
          } catch (e) { toastErr(e.message); }
        },
      },
    ],
  });
}

// ---- small form pieces ----------------------------------------------------
function group(title, kids) {
  const g = el('div');
  g.append(el('div.tiny.b', { style: { textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--muted)', marginBottom: '9px' } }, title));
  const box = el('div', { style: { display: 'grid', gap: '10px' } });
  for (const k of kids) if (k) box.append(k);
  g.append(box);
  return g;
}

function field(label, input, hint) {
  const row = el('div.field');
  row.append(el('label.tiny.b', { style: { display: 'block', marginBottom: '5px' } }, label));
  row.append(input);
  if (hint) row.append(el('p.tiny.muted', { style: { marginTop: '5px' } }, hint));
  return { row, input };
}

function numInput(value, { min, max, step } = {}) {
  return el('input.input', {
    type: 'number', inputmode: 'decimal',
    value: value === null || value === undefined ? '' : String(value),
    min: min != null ? String(min) : null,
    max: max != null ? String(max) : null,
    step: step || '1',
  });
}

function checkbox(label, checked) {
  const row = el('label.row', { style: { gap: '10px', alignItems: 'center', cursor: 'pointer' } });
  const input = el('input', { type: 'checkbox', style: { width: '18px', height: '18px', accentColor: 'var(--teal)', flex: 'none' } });
  input.checked = !!checked;
  row.append(input, el('span.small', label));
  return { row, input };
}
