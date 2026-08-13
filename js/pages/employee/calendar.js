import { Attendance, OffDays } from '../../lib/data.js?v=20260813d';
import { el, icon, pill, pageHead } from '../../lib/ui.js?v=20260813d';
import { ymd, todayYMD, fmtHM, minToHM, fmtLongDate, MONTHS, DOW } from '../../lib/time.js?v=20260813d';

export default async function calendarPage({ profile, navigate }) {
  const now = new Date();
  let year = now.getFullYear(), month = now.getMonth();
  const offDays = new Set((await OffDays.mine()).map(o => o.day_of_week));

  const screen = el('div.screen.fade-up');
  screen.append(pageHead('My Attendance', () => navigate('#/home')));

  const card = el('div.card');
  const head = el('div.cal-head');
  const moLabel = el('div.mo');
  const nav = el('div.cal-nav');
  const prev = el('button', { 'aria-label': 'Previous month', html: icon('chevL') });
  const todayBtn = el('button', { 'aria-label': 'Today', style: { width: 'auto', padding: '0 14px', fontSize: '13px', fontWeight: '700' }, html: 'Today' });
  const next = el('button', { 'aria-label': 'Next month', html: icon('chevR') });
  nav.append(prev, todayBtn, next);
  head.append(moLabel, nav);
  card.append(head);

  const dow = el('div.cal-dow');
  DOW.forEach(d => dow.append(el('span', d)));
  card.append(dow);

  const grid = el('div.cal-grid');
  card.append(grid);

  const legend = el('div.cal-legend');
  legend.innerHTML = `
    <span><i style="background:var(--teal)"></i>Present</span>
    <span><i style="background:var(--danger)"></i>Absent</span>
    <span><i style="background:var(--ink-3)"></i>Off day</span>
    <span><i style="box-shadow:inset 0 0 0 2px var(--teal);background:transparent"></i>Today</span>`;
  card.append(legend);
  screen.append(card);

  const detail = el('div.card', { style: { marginTop: '14px' } });
  screen.append(detail);

  async function draw() {
    moLabel.textContent = `${MONTHS[month]} ${year}`;
    grid.replaceChildren();
    const records = await Attendance.forMonth(profile.id, year, month);
    const byDate = Object.fromEntries(records.map(r => [r.work_date, r]));

    const first = new Date(year, month, 1).getDay();
    const daysIn = new Date(year, month + 1, 0).getDate();
    for (let i = 0; i < first; i++) grid.append(el('div.cal-cell.empty'));

    const today = todayYMD();
    for (let d = 1; d <= daysIn; d++) {
      const date = ymd(new Date(year, month, d));
      const jsDow = new Date(year, month, d).getDay();
      const rec = byDate[date];
      const cell = el('div.cal-cell', String(d));
      const isFuture = date > today;

      if (offDays.has(jsDow)) cell.classList.add('weekend');
      else if (rec) cell.classList.add('present');
      else if (!isFuture) cell.classList.add('absent');

      if (date === today) cell.classList.add('today');
      cell.addEventListener('click', () => selectDay(date, jsDow, rec, isFuture));
      grid.append(cell);
    }
    // auto-select today if in view, else clear
    if (year === new Date().getFullYear() && month === new Date().getMonth()) {
      const rec = byDate[today];
      selectDay(today, new Date().getDay(), rec, false);
      [...grid.children].find(c => c.classList.contains('today'))?.classList.add('sel');
    } else {
      detail.replaceChildren(el('p.small.muted.center-text', 'Select a day to see details'));
    }
  }

  function selectDay(date, jsDow, rec, isFuture) {
    [...grid.children].forEach(c => c.classList.remove('sel'));
    const idx = new Date(date + 'T00:00:00').getDate() + new Date(year, month, 1).getDay() - 1;
    grid.children[idx]?.classList.add('sel');

    const off = offDays.has(jsDow);
    const status = off ? 'weekend' : rec ? (rec.status === 'completed' ? 'present' : 'working') : isFuture ? null : 'absent';

    detail.replaceChildren();
    const top = el('div.row.between', { style: { marginBottom: '14px' } });
    top.append(el('div.b', fmtLongDate(new Date(date + 'T00:00:00'))));
    if (status) top.append(pill(status === 'present' ? 'present' : status));
    detail.append(top);

    if (rec) {
      const g = el('div.stat-3');
      g.append(
        detailStat('login', 'Clock In', rec.clock_in ? fmtHM(rec.clock_in) : '--:--'),
        detailStat('logout', 'Clock Out', rec.clock_out ? fmtHM(rec.clock_out) : '--:--'),
        detailStat('clock', 'Hours', minToHM(rec.total_minutes)),
      );
      detail.append(g);
    } else {
      detail.append(el('p.small.muted', off ? 'Scheduled weekly off day.' : isFuture ? 'Upcoming day.' : 'No attendance recorded.'));
    }
  }

  prev.addEventListener('click', () => { month--; if (month < 0) { month = 11; year--; } draw(); });
  next.addEventListener('click', () => { month++; if (month > 11) { month = 0; year++; } draw(); });
  todayBtn.addEventListener('click', () => { year = new Date().getFullYear(); month = new Date().getMonth(); draw(); });

  await draw();
  return screen;
}

function detailStat(ic, label, value) {
  const t = el('div.stat');
  t.innerHTML = `<div class="ic">${icon(ic)}</div><div class="v">${value}</div><div class="k">${label}</div>`;
  return t;
}
