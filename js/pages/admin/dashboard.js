import { Profiles, Attendance, Leaves, Permissions } from '../../lib/data.js?v=20260903a';
import { el, icon, avatar, pill, ring, emptyState } from '../../lib/ui.js?v=20260903a';
import { todayYMD, fmtTime, minToDur } from '../../lib/time.js?v=20260903a';
// Aliased: liveRow() below has its own local `mins` (elapsed minutes), and two
// bindings called `mins` in one module is a trap for the next reader.
import { hm12, mins as fmtMins } from '../../lib/money.js?v=20260903a';
import { POLL_MS } from '../../../config.js?v=20260903a';

export default async function adminDashboard({ navigate, refresh }) {
  const screen = el('div.fade-up');
  screen.append(header('Dashboard', 'Live attendance overview'));

  const kpiGrid = el('div.kpi-grid');
  screen.append(kpiGrid);

  const liveWrap = el('div', { style: { marginTop: '26px' } });
  liveWrap.append(el('div.section-h', el('h2', 'Who\'s In Right Now')));
  const liveList = el('div.list');
  liveWrap.append(liveList);
  screen.append(liveWrap);

  // Approved leave permissions for today — time out that is authorised, so it
  // must never be read as an absence or as an unexplained early finish.
  const permWrap = el('div', { style: { marginTop: '26px' } });
  permWrap.append(el('div.section-h', el('h2', 'Approved Leave Permissions Today')));
  const permList = el('div.list');
  permWrap.append(permList);
  screen.append(permWrap);

  async function load() {
    const [people, today, pending, perms] = await Promise.all([
      Profiles.all(), Attendance.range(todayYMD(), todayYMD()), Leaves.pending(),
      Permissions.approvedOn(todayYMD()).catch(() => []),   // pre-v7 database
    ]);
    const employees = people.filter(p => p.role === 'employee');
    const byEmp = Object.fromEntries(today.map(r => [r.employee_id, r]));

    const present = today.length;
    const working = today.filter(r => r.status === 'working' && !r.clock_out).length;
    const missing = employees.filter(e => !byEmp[e.id]).length;

    kpiGrid.replaceChildren(
      kpi('activity', 'blue', present, 'Present Today', present, employees.length),
      kpi('clock', 'teal', working, 'Currently Working'),
      kpi('alert', 'warn', missing, 'Not Clocked In'),
      kpi('calplus', 'danger', pending.length, 'Pending Leaves'),
      kpi('inbox', 'warn', perms.length, 'On Permission Today'),
      kpi('users', 'teal', employees.length, 'Total Team'),
    );

    // Who's in (working now), then completed today
    const workingRows = today.filter(r => r.status === 'working' && !r.clock_out)
      .sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in));
    liveList.replaceChildren();
    if (!workingRows.length) {
      liveList.append(el('div.card', emptyState('clock', 'Nobody is clocked in right now', 'Active employees will appear here in real time.')));
    } else {
      for (const r of workingRows) liveList.append(liveRow(r));
    }

    permList.replaceChildren();
    if (!perms.length) {
      permList.append(el('div.card', emptyState('checkcircle', 'Nobody is out on permission today',
        'Approved leave permissions for today would appear here.')));
    } else {
      for (const lp of perms) permList.append(permissionRow(lp));
    }
  }

  await load();

  // Lightweight realtime via polling.
  const timer = setInterval(() => { if (document.body.contains(screen)) load(); else clearInterval(timer); }, POLL_MS || 20000);

  return screen;
}

function header(title, sub) {
  const h = el('div', { style: { marginBottom: '22px' } });
  h.append(el('h1', { style: { fontSize: '26px', fontWeight: '800', letterSpacing: '-.02em' } }, title),
    el('p.muted.small', sub));
  return h;
}

function kpi(ic, tone, value, label, ringVal, ringMax) {
  const c = el('div.kpi');
  if (ringVal != null && ringMax) {
    c.append(ring({ value: ringVal, max: ringMax, size: 52, stroke: 6, color: 'var(--teal)', label: '', track: 'var(--surface-2)' }));
    c.firstChild.style.flex = 'none';
  } else {
    c.append(el('div.ic.ic--' + tone, { html: icon(ic) }));
  }
  c.append(el('div', el('div.v', String(value)), el('div.k', label)));
  return c;
}

// One approved leave permission. Deliberately labelled "Approved permission"
// rather than a leave/absence word — this time out is authorised and costs
// nothing unless a permission deduction is switched on for that employee.
function permissionRow(lp) {
  const p = lp.ta_profiles || {};
  const row = el('div.lrow');
  row.append(avatar(p, 'sm'));
  row.append(el('div.grow',
    el('div.name', p.full_name || 'Employee'),
    el('div.meta', `${hm12(lp.start_time)} – ${hm12(lp.end_time)} · ${fmtMins(lp.duration_minutes)}`
      + (lp.reason ? ` · ${lp.reason}` : ''))));
  row.append(el('span.pill.pill--approved',
    lp.approval_type === 'admin' ? 'Admin approved' : 'Approved permission'));
  return row;
}

export function liveRow(r) {
  const p = r.ta_profiles || {};
  const mins = r.clock_in ? Math.max(0, Math.round((Date.now() - new Date(r.clock_in)) / 60000)) : 0;
  const row = el('div.lrow');
  row.append(avatar(p, 'sm'));
  row.append(el('div.grow', el('div.name', p.full_name || 'Employee'), el('div.meta', p.position || p.department || '—')));
  const right = el('div', { style: { textAlign: 'right' } });
  right.append(el('div.small.b', fmtTime(r.clock_in)), el('div.tiny.muted', minToDur(mins)));
  row.append(right);
  row.append(pill('working'));
  return row;
}
