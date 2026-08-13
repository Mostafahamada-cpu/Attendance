import { Profiles, Attendance } from '../../lib/data.js?v=20260813c';
import { el, icon } from '../../lib/ui.js?v=20260813c';
import { ymd, fmtDayMon, minToHM, minToHoursDec, DOW } from '../../lib/time.js?v=20260813c';

const LATE_HOUR = 9, LATE_MIN = 15;   // arrivals after 09:15 count as late

export default async function adminAnalytics() {
  const employees = (await Profiles.all()).filter(p => p.role === 'employee');
  const empCount = employees.length || 1;

  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Attendance Analytics'),
    el('p.muted.small', 'Working-hour trends, attendance rate and punctuality')));

  // period control
  let period = 'week';
  const seg = el('div.seg', { style: { marginBottom: '18px' } });
  const customWrap = el('div.row', { style: { gap: '8px', marginBottom: '18px', display: 'none' } });
  const cFrom = el('input.input', { type: 'date', style: { maxWidth: '170px' } });
  const cTo = el('input.input', { type: 'date', style: { maxWidth: '170px' } });
  customWrap.append(cFrom, cTo);
  [['today', 'Today'], ['week', 'This Week'], ['month', 'This Month'], ['custom', 'Custom']].forEach(([v, l]) => {
    const b = el('button' + (v === period ? '.on' : ''), l);
    b.addEventListener('click', () => { period = v; [...seg.children].forEach(x => x.classList.remove('on')); b.classList.add('on'); customWrap.style.display = v === 'custom' ? 'flex' : 'none'; if (v !== 'custom') load(); });
    seg.append(b);
  });
  cFrom.addEventListener('change', load); cTo.addEventListener('change', load);
  screen.append(seg, customWrap);

  const kpiGrid = el('div.kpi-grid', { style: { marginBottom: '24px' } });
  screen.append(kpiGrid);

  const chartCard = el('div.card');
  chartCard.append(el('div.card-title', { style: { marginBottom: '14px' } }, 'Daily Working Hours'));
  const chartHost = el('div');
  chartCard.append(chartHost);
  screen.append(chartCard);

  function rangeFor() {
    const now = new Date();
    if (period === 'today') return [ymd(now), ymd(now)];
    if (period === 'week') { const s = new Date(now); s.setDate(now.getDate() - 6); return [ymd(s), ymd(now)]; }
    if (period === 'month') return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(now)];
    return [cFrom.value || ymd(now), cTo.value || ymd(now)];
  }

  async function load() {
    const [from, to] = rangeFor();
    kpiGrid.replaceChildren(skel(), skel(), skel(), skel());
    const recs = await Attendance.range(from, to);

    const totalMin = recs.reduce((s, r) => s + (r.total_minutes || 0), 0);
    const withHours = recs.filter(r => r.total_minutes > 0);
    const avgMin = withHours.length ? totalMin / withHours.length : 0;

    // distinct working days in range
    const days = distinctDates(from, to);
    const expected = empCount * days.length;
    const rate = expected ? Math.round(recs.length / expected * 100) : 0;

    const late = recs.filter(r => {
      if (!r.clock_in) return false;
      const d = new Date(r.clock_in);
      return d.getHours() > LATE_HOUR || (d.getHours() === LATE_HOUR && d.getMinutes() > LATE_MIN);
    }).length;
    const absences = Math.max(0, expected - recs.length);

    kpiGrid.replaceChildren(
      kpi('clock', 'teal', minToHoursDec(totalMin), 'Total Hours'),
      kpi('activity', 'blue', minToHM(avgMin), 'Avg / Shift'),
      kpi('trend', 'teal', rate + '%', 'Attendance Rate'),
      kpi('alert', 'warn', late, 'Late Arrivals'),
      kpi('xcircle', 'danger', absences, 'Absences'),
    );

    // chart: sum minutes per date
    const byDate = {};
    for (const r of recs) byDate[r.work_date] = (byDate[r.work_date] || 0) + (r.total_minutes || 0);
    const dates = days.slice(-14);
    const max = Math.max(...dates.map(d => byDate[d] || 0), 1);
    const chart = el('div.chart');
    if (!dates.length) chart.append(el('p.small.muted', 'No data in range'));
    for (const d of dates) {
      const v = byDate[d] || 0;
      const bar = el('div.cbar', { title: `${fmtDayMon(d)}: ${minToHM(v)}` });
      bar.append(el('div.fill', { style: { height: (v / max * 100) + '%' } }), el('div.cl', String(new Date(d + 'T00:00:00').getDate())));
      chart.append(bar);
    }
    chartHost.replaceChildren(chart);
  }

  await load();
  return screen;
}

function distinctDates(from, to) {
  const out = []; let d = new Date(from + 'T00:00:00'); const end = new Date(to + 'T00:00:00');
  while (d <= end) { out.push(ymd(d)); d.setDate(d.getDate() + 1); }
  return out;
}
function kpi(ic, tone, value, label) {
  const c = el('div.kpi');
  c.append(el('div.ic.ic--' + tone, { html: icon(ic) }), el('div', el('div.v', String(value)), el('div.k', label)));
  return c;
}
function skel() { return el('div.kpi.sk', { style: { height: '84px', boxShadow: 'none' } }); }
