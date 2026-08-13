import { Profiles, Balances } from '../../lib/data.js?v=20260813d';
import { el, icon, avatar, emptyState } from '../../lib/ui.js?v=20260813d';

export default async function adminBalances() {
  const [people, balances] = await Promise.all([Profiles.all(), Balances.all()]);
  const employees = people.filter(p => p.role === 'employee');

  // fold balances -> per employee
  const byEmp = {};
  for (const b of balances) {
    (byEmp[b.employee_id] ||= { casual: null, medical: null, planned: null, total: 0, used: 0 });
    byEmp[b.employee_id][b.leave_type] = b;
    byEmp[b.employee_id].total += b.total_days;
    byEmp[b.employee_id].used += b.used_days;
  }

  const rows = employees.map(p => {
    const b = byEmp[p.id] || { total: 0, used: 0, casual: null, medical: null, planned: null };
    return { p, ...b, remaining: b.total - b.used };
  });

  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Team Leave Balances'),
    el('p.muted.small', 'Spot low balances and heavy usage at a glance')));

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
    thead.innerHTML = '<tr><th>Employee</th><th>Total</th><th>Used</th><th>Remaining</th><th>Casual</th><th>Medical</th><th>Planned</th><th>Usage</th></tr>';
    table.append(thead);
    const tbody = el('tbody');
    if (!list.length) { const tr = el('tr'); const td = el('td', { colspan: '8' }); td.append(emptyState('briefcase', 'No matches')); tr.append(td); tbody.append(tr); }
    for (const r of list) {
      const tr = el('tr');
      const nameCell = el('td');
      const who = el('div.row', { style: { gap: '10px' } });
      who.append(avatar(r.p, 'sm'), el('div', el('div.b', r.p.full_name), el('div.tiny.muted', r.p.department || '—')));
      nameCell.append(who);
      tr.append(nameCell);
      tr.append(td(r.total), td(r.used), remainingCell(r.remaining), typeCell(r.casual), typeCell(r.medical), typeCell(r.planned), usageCell(r));
      tbody.append(tr);
    }
    table.append(tbody);
  }

  sInput.addEventListener('input', draw);
  draw();
  return screen;
}

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
