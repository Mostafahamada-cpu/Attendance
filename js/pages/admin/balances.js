import { Profiles, Balances, BalanceLog } from '../../lib/data.js?v=20260903a';
import { el, icon, avatar, emptyState } from '../../lib/ui.js?v=20260903a';
import { toastOk, toastErr, modal } from '../../lib/toast.js?v=20260903a';
import { ago } from '../../lib/time.js?v=20260903a';

export const LEAVE_TYPES = [
  ['casual', 'Casual'],
  ['medical', 'Medical'],
  ['planned', 'Planned'],
];

export default async function adminBalances({ refresh } = {}) {
  const [people, balances] = await Promise.all([Profiles.all(), Balances.all()]);
  // Everyone with a profile, not just role='employee'. An admin is a member of
  // staff too — they clock in and take leave — and excluding them here would
  // leave their own allowance with no way to be seen or corrected.
  const staff = people;

  // fold balances -> per employee
  const byEmp = {};
  for (const b of balances) {
    (byEmp[b.employee_id] ||= { casual: null, medical: null, planned: null, total: 0, used: 0 });
    byEmp[b.employee_id][b.leave_type] = b;
    byEmp[b.employee_id].total += b.total_days;
    byEmp[b.employee_id].used += b.used_days;
  }

  const rows = staff.map(p => {
    const b = byEmp[p.id] || { total: 0, used: 0, casual: null, medical: null, planned: null };
    return { p, ...b, remaining: b.total - b.used };
  });

  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Vacation Balances'),
    el('p.muted.small', 'View and edit each employee\'s vacation allowance. Changes save to the database immediately and show in their account.')));

  // controls
  const controls = el('div.row.wrap', { style: { gap: '12px', marginBottom: '18px' } });
  const search = el('div.input-icon', { style: { maxWidth: '300px', flex: '1' } });
  search.innerHTML = `<span class="i-lead">${icon('search')}</span>`;
  const sInput = el('input.input', { placeholder: 'Search…' });
  search.append(sInput);
  let flt = 'all';
  const seg = el('div.seg');
  [['all', 'All'], ['low', 'Low remaining'], ['high', 'High usage'], ['unused', 'No leave taken']].forEach(([v, l]) => {
    const b = el('button' + (v === flt ? '.on' : ''), l);
    b.addEventListener('click', () => { flt = v; [...seg.children].forEach(x => x.classList.remove('on')); b.classList.add('on'); draw(); });
    seg.append(b);
  });
  controls.append(search, seg);
  screen.append(controls);

  const wrap = el('div.table-wrap');
  const table = el('table.tbl');
  wrap.append(table);
  screen.append(wrap);

  screen.append(el('p.tiny.muted', { style: { marginTop: '12px' } },
    'Only the allowance (Total) is editable. Used days come from approved leave and cannot be set by hand. ' +
    'A total can never be dropped below the days an employee has already used.'));

  function apply(list) {
    const q = sInput.value.toLowerCase();
    return list.filter(r => {
      if (q && !(r.p.full_name || '').toLowerCase().includes(q) && !(r.p.department || '').toLowerCase().includes(q)) return false;
      if (flt === 'low') return r.remaining <= 5;
      if (flt === 'high') return r.total > 0 && r.used / r.total >= 0.6;
      if (flt === 'unused') return r.used === 0;
      return true;
    });
  }

  function draw() {
    const list = apply(rows);
    table.replaceChildren();
    const thead = el('thead');
    thead.innerHTML = '<tr><th>Employee</th><th>Total</th><th>Used</th><th>Remaining</th>'
      + '<th>Casual</th><th>Medical</th><th>Planned</th><th>Usage</th><th></th></tr>';
    table.append(thead);
    const tbody = el('tbody');
    if (!list.length) { const tr = el('tr'); const td2 = el('td', { colspan: '9' }); td2.append(emptyState('briefcase', 'No matches')); tr.append(td2); tbody.append(tr); }
    for (const r of list) {
      const tr = el('tr');
      const nameCell = el('td');
      const who = el('div.row', { style: { gap: '10px' } });
      const nameLine = el('div.row', { style: { gap: '7px' } }, el('span.b', r.p.full_name));
      if (r.p.role === 'admin') nameLine.append(el('span.pill.pill--working', { style: { height: '20px', fontSize: '10.5px', padding: '0 8px' } }, 'Admin'));
      who.append(avatar(r.p, 'sm'), el('div', nameLine, el('div.tiny.muted', r.p.department || '—')));
      nameCell.append(who);
      tr.append(nameCell);
      tr.append(td(r.total), td(r.used), remainingCell(r.remaining),
        typeCell(r.casual), typeCell(r.medical), typeCell(r.planned), usageCell(r), actionCell(r));
      tbody.append(tr);
    }
    table.append(tbody);
  }

  function actionCell(r) {
    const t = el('td');
    const b = el('button.btn.btn--pill-line.btn--sm', 'Edit balance');
    b.addEventListener('click', () => editVacationBalance(r.p, r, refresh));
    t.append(b);
    return t;
  }

  sInput.addEventListener('input', draw);
  draw();
  return screen;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Edit Vacation Balance
//  Shared by this screen and the Employees drill-down so both offer exactly the
//  same dialog and the same guard rails.
//
//  `row` may be a folded row from this page or { casual, medical, planned }
//  balance records fetched anywhere else; only those three keys are read.
// ─────────────────────────────────────────────────────────────────────────────
export function editVacationBalance(person, row, onSaved) {
  const body = el('div');
  body.append(el('p.small.muted', { style: { marginBottom: '14px' } },
    `Set the number of vacation days available to ${person.full_name}. Saved to the database and shown in their account straight away.`));

  const inputs = {};
  const grid = el('div', { style: { display: 'grid', gap: '12px' } });
  for (const [key, label] of LEAVE_TYPES) {
    const b = row?.[key];
    const used = b?.used_days ?? 0;
    const r = el('div.row.between', {
      style: { gap: '12px', padding: '11px 13px', background: 'var(--surface-2)', borderRadius: 'var(--r)' },
    });
    const input = el('input.input', {
      type: 'number', min: String(used), max: '365', step: '1',
      value: String(b?.total_days ?? 0),
      style: { width: '92px', textAlign: 'center', flex: 'none' },
    });
    inputs[key] = { input, used, before: b?.total_days ?? 0 };
    const hint = el('div.tiny.muted', used ? `${used} used · minimum ${used}` : 'None used yet');
    r.append(el('div.grow', el('div.small.b', label + ' leave'), hint), input);
    grid.append(r);
  }
  body.append(grid);

  const note = el('input.input', { placeholder: 'Reason for the change (optional)', style: { marginTop: '12px' } });
  body.append(note);

  const histHost = el('div', { style: { marginTop: '14px' } });
  body.append(histHost);
  loadHistory(person.id, histHost);

  modal({
    title: 'Edit Vacation Balance',
    body,
    actions: [
      { label: 'Cancel', cls: 'btn--pill-line' },
      {
        label: 'Save balance', cls: 'btn--primary',
        onClick: async (close) => {
          const patch = {};
          for (const [key, label] of LEAVE_TYPES) {
            const { input, used, before } = inputs[key];
            const v = parseInt(input.value, 10);
            if (!Number.isInteger(v) || v < 0) return toastErr(`${label}: enter a whole number of days`);
            if (v > 365) return toastErr(`${label}: 365 days is the maximum`);
            if (v < used) return toastErr(`${label}: ${person.full_name} has already used ${used} day(s) — the total can't be lower`);
            if (v !== before) patch[key] = v;      // send only what actually changed
          }
          if (!Object.keys(patch).length) { close(); return toastOk('No changes to save'); }
          try {
            // One atomic call: if any type is rejected server-side, none of
            // them move, so the admin never sees a half-applied edit.
            await Balances.setAll(person.id, patch, note.value.trim() || null);
            close();
            toastOk('Vacation balance saved');
            onSaved?.();
          } catch (e) { toastErr(e.message); }
        },
      },
    ],
  });
}

async function loadHistory(empId, host) {
  let log = [];
  try { log = await BalanceLog.forEmployee(empId, 5); } catch (_) { return; }
  if (!log.length) return;
  host.append(el('div.tiny.muted.b', { style: { marginBottom: '6px' } }, 'Recent changes'));
  for (const a of log) {
    const r = el('div.row.between', { style: { padding: '7px 0', borderBottom: '1px solid var(--line)', gap: '10px' } });
    r.append(
      el('span.tiny', `${cap(a.leave_type)} ${a.total_before} → ${a.total_after} days`),
      el('span.tiny.muted', `${a.changed?.full_name || 'Admin'} · ${ago(a.created_at)}`));
    host.append(r);
  }
}

const cap = (s) => (s || '').charAt(0).toUpperCase() + (s || '').slice(1);

function td(v) { return el('td', { style: { fontWeight: '600' } }, String(v)); }
function typeCell(b) { return el('td', b ? `${b.remaining_days}/${b.total_days}` : '—'); }
function remainingCell(v) {
  const t = el('td');
  const p = el('span.pill', String(v) + ' days');
  p.classList.add(v <= 3 ? 'pill--denied' : v <= 6 ? 'pill--pending' : 'pill--approved');
  t.append(p);
  return t;
}
function usageCell(r) {
  const pct = r.total > 0 ? Math.round(r.used / r.total * 100) : 0;
  const t = el('td', { style: { minWidth: '120px' } });
  const bar = el('div.bar' + (pct >= 80 ? '.bar--danger' : pct >= 60 ? '.bar--warn' : ''), { style: { width: '100px' } });
  bar.append(el('span', { style: { width: pct + '%' } }));
  t.append(el('div.row', { style: { gap: '8px' } }, bar, el('span.tiny.muted', pct + '%')));
  return t;
}
