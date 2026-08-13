import { Profiles, Attendance, OffDays } from '../../lib/data.js?v=20260813c';
import { el, icon, avatar, pill, emptyState } from '../../lib/ui.js?v=20260813c';
import { ymd, todayYMD, fmtShortDate, fmtHM, minToHM, minToDur, MONTHS, DOW } from '../../lib/time.js?v=20260813c';

export default async function adminEmployees() {
  const people = (await Profiles.all()).filter(p => p.role === 'employee');
  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Employees'),
    el('p.muted.small', 'Select an employee to inspect their attendance')));

  const search = el('div.input-icon', { style: { marginBottom: '18px', maxWidth: '360px' } });
  search.innerHTML = `<span class="i-lead">${icon('search')}</span>`;
  const sInput = el('input.input', { placeholder: 'Search employees…' });
  search.append(sInput);
  screen.append(search);

  const grid = el('div', { style: { display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))' } });
  screen.append(grid);
  const detailHost = el('div');
  screen.append(detailHost);

  function drawList(q = '') {
    grid.replaceChildren();
    const rows = people.filter(p => (p.full_name || '').toLowerCase().includes(q.toLowerCase()) || (p.department || '').toLowerCase().includes(q.toLowerCase()));
    if (!rows.length) { grid.append(el('div.card', emptyState('users', 'No employees found'))); return; }
    for (const p of rows) {
      const c = el('button.card.row', { style: { gap: '12px', textAlign: 'left', width: '100%', cursor: 'pointer' } });
      c.append(avatar(p, 'sm'), el('div.grow', el('div.b', p.full_name), el('div.tiny.muted', `${p.position || 'Employee'} · ${p.department || 'General'}`)), iconSpan('chevR'));
      c.addEventListener('click', () => openDetail(p));
      grid.append(c);
    }
  }

  async function openDetail(p) {
    detailHost.replaceChildren();
    const modalScrim = el('div.modal-scrim', { style: { placeItems: 'center' } });
    const panel = el('div.modal', { style: { maxWidth: '640px', maxHeight: '88vh', overflowY: 'auto', borderRadius: 'var(--r-xl)' } });
    const close = () => modalScrim.remove();
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
    detailHost.append(modalScrim);

    const now = new Date();
    const [recs, off] = await Promise.all([Attendance.forMonth(p.id, now.getFullYear(), now.getMonth()), OffDays.mine(p.id)]);
    panel.lastChild.remove();

    // Stats this month
    const present = recs.length;
    const totalMin = recs.reduce((s, r) => s + (r.total_minutes || 0), 0);
    const offSet = new Set(off.map(o => o.day_of_week));
    const workdays = countWorkdays(now.getFullYear(), now.getMonth(), offSet, todayYMD());
    const absent = Math.max(0, workdays - present);

    const stats = el('div.stat-3', { style: { marginBottom: '18px' } });
    stats.append(mini('Present', present), mini('Absent', absent), mini('Avg Hrs', recs.length ? minToHM(totalMin / recs.length) : '00:00'));
    panel.append(el('div.card-sub.b', { style: { marginBottom: '8px' } }, `${MONTHS[now.getMonth()]} ${now.getFullYear()}`), stats);

    // Weekly pattern (avg minutes per weekday)
    panel.append(el('div.section-h', el('h2', { style: { fontSize: '15px' } }, 'Weekly Pattern')));
    panel.append(weeklyPattern(recs, offSet));

    // History list
    panel.append(el('div.section-h', el('h2', { style: { fontSize: '15px' } }, 'Recent History')));
    if (!recs.length) panel.append(emptyState('calendar', 'No records this month'));
    else {
      const list = el('div.list');
      [...recs].reverse().slice(0, 12).forEach(r => {
        const row = el('div.lrow');
        row.append(el('div.grow', el('div.name', fmtShortDate(r.work_date)), el('div.meta', `${fmtHM(r.clock_in)} – ${r.clock_out ? fmtHM(r.clock_out) : '—'}`)));
        row.append(el('div.small.b', minToDur(r.total_minutes)), pill(r.status === 'completed' ? 'present' : 'working'));
        list.append(row);
      });
      panel.append(list);
    }
  }

  sInput.addEventListener('input', () => drawList(sInput.value));
  drawList();
  return screen;
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
