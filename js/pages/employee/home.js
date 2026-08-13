import { Attendance, Balances } from '../../lib/data.js?v=20260813d';
import { el, icon, avatar, ring, iconEl } from '../../lib/ui.js?v=20260813d';
import { toastOk, toastErr, confirmDialog } from '../../lib/toast.js?v=20260813d';
import { fmtTime, fmtHM, fmtLongDate, minToHM, minToDur } from '../../lib/time.js?v=20260813d';

export default async function empHome({ profile, navigate, refresh }) {
  const [today, balances] = await Promise.all([Attendance.today(), Balances.mine()]);

  const screen = el('div.screen.fade-up');

  // ── Greeting bar ──────────────────────────────────────────────────────────
  const top = el('div.topbar');
  top.append(avatar(profile));
  const greet = el('div');
  const hr = new Date().getHours();
  const salut = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  greet.append(el('div.hello', salut), el('div.name', firstName(profile)));
  const now = el('div.clock-now');
  const nowT = el('div.t'), nowD = el('div.d', fmtLongDate());
  now.append(nowT, nowD);
  top.append(greet, now);
  screen.append(top);

  // ── Clock card ────────────────────────────────────────────────────────────
  const clockCard = el('div.card');
  const clockWrap = el('div.clock-wrap');
  clockCard.append(clockWrap);
  const stat3 = el('div.stat-3', { style: { marginTop: '18px' } });
  clockCard.append(stat3);
  screen.append(clockCard);

  let record = today;               // local mutable copy
  let tick;                         // live timer interval

  function workedMinutes() {
    if (!record?.clock_in) return 0;
    const end = record.clock_out ? new Date(record.clock_out) : new Date();
    return Math.max(0, Math.round((end - new Date(record.clock_in)) / 60000));
  }

  function renderStats() {
    stat3.replaceChildren(
      statTile('login', 'Clock In', record?.clock_in ? fmtHM(record.clock_in) : '--:--'),
      statTile('logout', 'Clock Out', record?.clock_out ? fmtHM(record.clock_out) : '--:--'),
      statTile('clock', 'Working Hrs', minToHM(workedMinutes())),
    );
  }

  function renderClock() {
    clearInterval(tick);
    clockWrap.replaceChildren();

    if (!record) {
      // Before clock-in
      const btn = clockBtn('in', 'Clock In', 'Tap to start your day');
      btn.addEventListener('click', () => doClockIn(btn));
      clockWrap.append(btn);
    } else if (record.status === 'working' && !record.clock_out) {
      // Working — show live duration + clock out
      const info = el('div.center-text', { style: { marginBottom: '16px' } });
      info.append(
        el('div.tiny.muted', 'Clocked in at ' + fmtTime(record.clock_in)),
        el('div', { style: { fontSize: '30px', fontWeight: '800', fontVariantNumeric: 'tabular-nums', letterSpacing: '-.02em' } }, minToDur(workedMinutes())),
        el('div.pill.pill--working', { style: { marginTop: '6px' } }, 'Working now'),
      );
      const btn = clockBtn('out', 'Clock Out', 'Tap to end your day');
      btn.addEventListener('click', () => doClockOut(btn));
      clockWrap.append(info, btn);
      tick = setInterval(() => { info.querySelector('div:nth-child(2)').textContent = minToDur(workedMinutes()); renderStats(); }, 1000);
    } else {
      // Completed
      const done = clockBtn('done', 'Time Marked', 'You\'re all set for today');
      done.innerHTML = `${icon('checkcircle', 'ci')}<div class="lbl">Time Marked</div><div class="sub">${minToDur(record.total_minutes)} today</div>`;
      clockWrap.append(done);
    }
    renderStats();
  }

  async function doClockIn(btn) {
    btn.disabled = true; btn.style.opacity = '.6';
    try {
      record = await Attendance.clockIn();
      toastOk('Clocked in at ' + fmtTime(record.clock_in));
      renderClock();
    } catch (e) {
      if (/duplicate|unique/i.test(e.message)) { toastErr('Already clocked in today'); record = await Attendance.today(); renderClock(); }
      else { toastErr(e.message); btn.disabled = false; btn.style.opacity = '1'; }
    }
  }

  function doClockOut(btn) {
    confirmDialog({
      title: 'Clock out?', message: `You've worked ${minToDur(workedMinutes())} so far. End your workday now?`,
      confirmLabel: 'Clock Out',
      onConfirm: async () => {
        btn.disabled = true;
        try {
          const mins = workedMinutes();
          record = await Attendance.clockOut(record.id, mins).then(r => Array.isArray(r) ? r[0] : r);
          record = record || { ...record, clock_out: new Date().toISOString(), total_minutes: mins, status: 'completed' };
          toastOk('Clocked out — ' + minToDur(mins) + ' logged');
          renderClock();
        } catch (e) { toastErr(e.message); btn.disabled = false; }
      },
    });
  }

  renderClock();

  // ── Leave balance ─────────────────────────────────────────────────────────
  screen.append(sectionHead('Leave Balance', 'View all', () => navigate('#/leaves')));
  screen.append(leaveBalanceCard(balances));

  // ── Quick actions ─────────────────────────────────────────────────────────
  const quick = el('div.row', { style: { gap: '12px', marginTop: '16px' } });
  const applyBtn = el('button.btn.btn--primary.grow'); applyBtn.innerHTML = icon('calplus') + '<span>Apply Leave</span>';
  applyBtn.addEventListener('click', () => navigate('#/apply'));
  const calBtn = el('button.btn.btn--ghost.grow'); calBtn.innerHTML = icon('calendar') + '<span>Calendar</span>';
  calBtn.addEventListener('click', () => navigate('#/attendance'));
  quick.append(applyBtn, calBtn);
  screen.append(quick);

  // live wall clock in greeting
  const wall = () => { nowT.textContent = fmtTime(new Date()); };
  wall(); const wallTimer = setInterval(wall, 1000);
  // cleanup when node detached
  observeDetach(screen, () => { clearInterval(tick); clearInterval(wallTimer); });

  return screen;
}

// ---- pieces ---------------------------------------------------------------
function firstName(p) { return (p?.full_name || 'there').split(' ')[0]; }

function statTile(ic, label, value) {
  const t = el('div.stat');
  t.innerHTML = `<div class="ic">${icon(ic)}</div><div class="v">${value}</div><div class="k">${label}</div>`;
  return t;
}

function clockBtn(kind, label, sub) {
  const b = el('button.clock-btn.clock-btn--' + kind, { 'aria-label': label });
  if (kind !== 'done') b.append(el('span.pulse'));
  b.innerHTML += `${icon('fingerprint', 'ci')}<div class="lbl">${label}</div><div class="sub">${sub}</div>`;
  return b;
}

function sectionHead(title, linkText, onClick) {
  const h = el('div.section-h');
  h.append(el('h2', title));
  if (linkText) { const a = el('button.link', linkText); a.addEventListener('click', onClick); h.append(a); }
  return h;
}

export function leaveBalanceCard(balances) {
  const total = balances.reduce((s, b) => s + b.total_days, 0);
  const used = balances.reduce((s, b) => s + b.used_days, 0);
  const remaining = total - used;
  const card = el('div.card');

  const head = el('div.row.between', { style: { marginBottom: '18px' } });
  head.append(ring({ value: remaining, max: total || 1, size: 96, stroke: 10, color: 'var(--teal)', label: remaining, sub: 'left' }));
  const legend = el('div.col', { style: { gap: '10px', flex: '1', marginLeft: '18px' } });
  legend.append(
    legendRow('var(--teal)', 'Total', total),
    legendRow('var(--info)', 'Used', used),
    legendRow('var(--warn)', 'Remaining', remaining),
  );
  head.append(legend);
  card.append(head);

  const types = { casual: ['Casual', 'var(--teal)'], medical: ['Medical', 'var(--danger)'], planned: ['Planned', 'var(--info)'] };
  const rings = el('div.leave-rings');
  for (const b of balances) {
    const [lbl, col] = types[b.leave_type] || [b.leave_type, 'var(--teal)'];
    const cell = el('div');
    cell.append(ring({ value: b.remaining_days, max: b.total_days || 1, size: 76, stroke: 8, color: col, label: b.remaining_days, sub: `/${b.total_days}` }));
    cell.append(el('div.lr-k', lbl));
    rings.append(cell);
  }
  card.append(rings);
  return card;
}

function legendRow(color, label, value) {
  const r = el('div.row.between');
  const left = el('div.row', { style: { gap: '8px' } });
  left.append(el('i', { style: { width: '9px', height: '9px', borderRadius: '50%', background: color, display: 'inline-block' } }), el('span.small.muted', label));
  r.append(left, el('span.b', String(value) + ' days'));
  return r;
}

// Detects when a node leaves the DOM so timers can be cleared.
function observeDetach(node, cb) {
  const obs = new MutationObserver(() => {
    if (!document.body.contains(node)) { cb(); obs.disconnect(); }
  });
  obs.observe(document.getElementById('app'), { childList: true, subtree: true });
}
