import { Attendance, Balances, Settings } from '../../lib/data.js?v=20260830b';
import { el, icon, avatar, ring } from '../../lib/ui.js?v=20260830b';
import { toastOk, toastErr, confirmDialog, modal } from '../../lib/toast.js?v=20260830b';
import { fmtTime, fmtHM, fmtLongDate, minToHM, minToDur } from '../../lib/time.js?v=20260830b';
import {
  getPositionWithFallback, evaluate, fmtDistance, permissionState,
  isSupported, isSecureOrigin, GeoError, DEFAULT_GEOFENCE,
} from '../../lib/geo.js?v=20260830b';

export default async function empHome({ profile, navigate, refresh }) {
  const [today, balances, cfg] = await Promise.all([
    Attendance.today(),
    Balances.mine(),
    Settings.get().catch(() => null),          // pre-v2 database → fall back
  ]);
  const geofence = cfg || DEFAULT_GEOFENCE;

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

  // Location status strip — always visible so people know what will happen
  // before they tap, on mobile and desktop alike.
  const geoStrip = el('div.geo-strip');
  clockCard.append(geoStrip);

  const stat3 = el('div.stat-3', { style: { marginTop: '18px' } });
  clockCard.append(stat3);
  screen.append(clockCard);

  let record = today;               // local mutable copy
  let tick;                         // live timer interval
  let lastFix = null;               // last successful position
  let lastCheck = null;             // evaluate() result for lastFix
  let geoBusy = false;

  function workedMinutes() {
    if (!record?.clock_in) return 0;
    const end = record.clock_out ? new Date(record.clock_out) : new Date();
    return Math.max(0, Math.round((end - new Date(record.clock_in)) / 60000));
  }

  // ── Location strip ────────────────────────────────────────────────────────
  function renderGeo(stateText, tone, sub, action) {
    geoStrip.replaceChildren();
    geoStrip.className = 'geo-strip geo-strip--' + tone;
    const ic = el('span.gi', { html: icon(tone === 'ok' ? 'pin' : tone === 'bad' ? 'pinoff' : 'target') });
    const txt = el('div.grow');
    txt.append(el('div.gt', stateText));
    if (sub) txt.append(el('div.gs', sub));
    geoStrip.append(ic, txt);
    if (action) geoStrip.append(action);
  }

  function geoRefreshBtn(label = 'Check') {
    const b = el('button.geo-act', label);
    b.addEventListener('click', () => locate({ announce: true }));
    return b;
  }

  // Reads the device location and updates the strip. Never throws.
  async function locate({ announce = false } = {}) {
    if (geoBusy) return null;
    if (!geofence.geofence_enabled) {
      renderGeo('Location check is off', 'idle', 'An admin has disabled the attendance geofence.');
      return null;
    }
    geoBusy = true;
    renderGeo('Checking your location…', 'idle', 'Waiting for a GPS fix');
    try {
      const pos = await getPositionWithFallback();
      lastFix = pos;
      lastCheck = evaluate(pos, geofence);
      const acc = pos.accuracy != null ? ` · ±${Math.round(pos.accuracy)} m accuracy` : '';
      if (lastCheck.reason === 'accuracy') {
        renderGeo('GPS signal too weak', 'warn',
          `Accuracy is ±${Math.round(pos.accuracy)} m — needs ±${geofence.max_accuracy_m} m or better.`,
          geoRefreshBtn('Retry'));
      } else if (lastCheck.inside) {
        renderGeo('You\'re at the attendance location', 'ok',
          `${fmtDistance(lastCheck.distance)} from the office · allowed radius ${lastCheck.radius} m${acc}`,
          geoRefreshBtn());
      } else {
        renderGeo('Outside the attendance area', 'bad',
          `You're about ${fmtDistance(lastCheck.distance)} away — the allowed radius is ${lastCheck.radius} m.`,
          geoRefreshBtn('Retry'));
      }
      if (announce && lastCheck.inside) toastOk('Location confirmed — ' + fmtDistance(lastCheck.distance) + ' away');
      return pos;
    } catch (e) {
      lastFix = null; lastCheck = null;
      const denied = e instanceof GeoError && e.code === 'denied';
      renderGeo(denied ? 'Location permission blocked' : 'Location unavailable', 'bad',
        e.message, denied ? helpBtn() : geoRefreshBtn('Retry'));
      if (announce) toastErr(e.message);
      return null;
    } finally { geoBusy = false; }
  }

  function helpBtn() {
    const b = el('button.geo-act', 'How to fix');
    b.addEventListener('click', showPermissionHelp);
    return b;
  }

  // ── Clock UI ──────────────────────────────────────────────────────────────
  function renderClock() {
    clearInterval(tick);
    clockWrap.replaceChildren();

    if (!record) {
      const btn = clockBtn('in', 'Clock In', 'Tap to start your day');
      btn.addEventListener('click', () => doClock('in', btn));
      clockWrap.append(btn);
    } else if (record.status === 'working' && !record.clock_out) {
      const info = el('div.center-text', { style: { marginBottom: '16px' } });
      info.append(
        el('div.tiny.muted', 'Clocked in at ' + fmtTime(record.clock_in)),
        el('div', { style: { fontSize: '30px', fontWeight: '800', fontVariantNumeric: 'tabular-nums', letterSpacing: '-.02em' } }, minToDur(workedMinutes())),
        el('div.pill.pill--working', { style: { marginTop: '6px' } }, 'Working now'),
      );
      const btn = clockBtn('out', 'Clock Out', 'Tap to end your day');
      btn.addEventListener('click', () => doClock('out', btn));
      clockWrap.append(info, btn);
      tick = setInterval(() => { info.querySelector('div:nth-child(2)').textContent = minToDur(workedMinutes()); renderStats(); }, 1000);
    } else {
      const done = clockBtn('done', 'Time Marked', 'You\'re all set for today');
      done.innerHTML = `${icon('checkcircle', 'ci')}<div class="lbl">Time Marked</div><div class="sub">${minToDur(record.total_minutes)} today</div>`;
      clockWrap.append(done);
    }
    renderStats();
  }

  function renderStats() {
    stat3.replaceChildren(
      statTile('login', 'Clock In', record?.clock_in ? fmtHM(record.clock_in) : '--:--'),
      statTile('logout', 'Clock Out', record?.clock_out ? fmtHM(record.clock_out) : '--:--'),
      statTile('clock', 'Working Hrs', minToHM(workedMinutes())),
    );
  }

  // Clock in and clock out share one flow: fresh fix → local pre-check →
  // server RPC (which re-validates and is the real gate).
  async function doClock(kind, btn) {
    const label = kind === 'in' ? 'Clock In' : 'Clock Out';
    const busy = (on, text) => {
      btn.disabled = on;
      btn.style.opacity = on ? '.6' : '1';
      const sub = btn.querySelector('.sub');
      if (sub) sub.textContent = on ? text : (kind === 'in' ? 'Tap to start your day' : 'Tap to end your day');
    };

    busy(true, 'Checking location…');
    let pos = null;
    if (geofence.geofence_enabled) {
      try {
        pos = await getPositionWithFallback();
      } catch (e) {
        busy(false);
        lastFix = null; lastCheck = null;
        const denied = e instanceof GeoError && e.code === 'denied';
        renderGeo(denied ? 'Location permission blocked' : 'Location unavailable', 'bad', e.message,
          denied ? helpBtn() : geoRefreshBtn('Retry'));
        return blockedDialog(label, e.message, e instanceof GeoError && e.code === 'denied');
      }
      lastFix = pos;
      lastCheck = evaluate(pos, geofence);

      if (lastCheck.reason === 'accuracy') {
        busy(false);
        renderGeo('GPS signal too weak', 'warn',
          `Accuracy is ±${Math.round(pos.accuracy)} m — needs ±${geofence.max_accuracy_m} m or better.`, geoRefreshBtn('Retry'));
        return blockedDialog(label,
          `Your GPS reading is only accurate to ±${Math.round(pos.accuracy)} m, which isn't precise enough to confirm you're at the office. Move outdoors or near a window and try again.`);
      }
      if (!lastCheck.inside) {
        busy(false);
        renderGeo('Outside the attendance area', 'bad',
          `You're about ${fmtDistance(lastCheck.distance)} away — the allowed radius is ${lastCheck.radius} m.`, geoRefreshBtn('Retry'));
        return blockedDialog(label,
          `You are outside the allowed attendance area. Please move closer to the attendance location.\n\nYou are about ${fmtDistance(lastCheck.distance)} from the attendance location — the allowed radius is ${lastCheck.radius} m.`);
      }
      renderGeo('You\'re at the attendance location', 'ok',
        `${fmtDistance(lastCheck.distance)} from the office · allowed radius ${lastCheck.radius} m`, geoRefreshBtn());
    } else {
      // Geofence disabled by an admin — still send whatever fix we can get so
      // the location is recorded on the attendance row.
      pos = await getPositionWithFallback().catch(() => null);
    }

    const payload = pos ? { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy } : { lat: null, lng: null, accuracy: null };

    if (kind === 'out') {
      busy(false);
      confirmDialog({
        title: 'Clock out?',
        message: `You've worked ${minToDur(workedMinutes())} so far. End your workday now?`,
        confirmLabel: 'Clock Out',
        onConfirm: () => send(),
      });
      return;
    }
    return send();

    async function send() {
      busy(true, 'Saving…');
      try {
        const row = await (kind === 'in' ? Attendance.clockIn(payload) : Attendance.clockOut(payload));
        record = Array.isArray(row) ? row[0] : row;
        toastOk(kind === 'in'
          ? 'Clocked in at ' + fmtTime(record.clock_in)
          : 'Clocked out — ' + minToDur(record.total_minutes) + ' logged');
        renderClock();
      } catch (e) {
        busy(false);
        const msg = e?.message || 'Something went wrong';
        // The server is the authority: if it refused, show exactly why. `reason`
        // is the machine-readable code from ta_clock_in / ta_clock_out.
        const reason = e?.reason;
        const geoRefusal = ['outside radius', 'gps accuracy rejected', 'invalid or missing coordinates'];
        if (geoRefusal.includes(reason) || /outside the allowed attendance area|GPS signal|Location required/i.test(msg)) {
          blockedDialog(label, msg, false, false);
        } else if (reason === 'duplicate' || /already clocked in/i.test(msg)) {
          toastErr('Already clocked in today');
          record = await Attendance.today(); renderClock();
        } else if (reason === 'not clocked in' || reason === 'already clocked out'
                   || /already clocked out|have not clocked in/i.test(msg)) {
          toastErr(msg);
          record = await Attendance.today(); renderClock();
        } else {
          toastErr(msg);
        }
      }
    }
  }

  // showLocal=false when the message came from the SERVER: the server's own
  // numbers are in the message, and repeating our local reading next to them
  // would contradict it.
  function blockedDialog(action, message, showHelp = false, showLocal = true) {
    const body = el('div');
    body.append(el('p.small', { style: { whiteSpace: 'pre-line', lineHeight: '1.6', color: 'var(--ink-2)' } }, message));
    if (showLocal && lastCheck && lastCheck.distance != null) {
      const box = el('div.geo-detail', { style: { marginTop: '14px' } });
      box.append(
        detailLine('Your distance', fmtDistance(lastCheck.distance)),
        detailLine('Allowed radius', lastCheck.radius + ' m'),
        lastFix?.accuracy != null ? detailLine('GPS accuracy', '±' + Math.round(lastFix.accuracy) + ' m') : null,
      );
      body.append(box);
    }
    return modal({
      title: action + ' blocked',
      body,
      actions: [
        { label: 'Close', cls: 'btn--pill-line' },
        showHelp
          ? { label: 'How to fix', cls: 'btn--primary', onClick: (close) => { close(); showPermissionHelp(); } }
          : { label: 'Check again', cls: 'btn--primary', onClick: (close) => { close(); locate({ announce: true }); } },
      ],
    });
  }

  renderClock();

  // ── Leave balance ─────────────────────────────────────────────────────────
  screen.append(sectionHead('Leave Balance', 'View all', () => navigate('#/leaves')));
  screen.append(leaveBalanceCard(balances));

  // ── Quick actions ─────────────────────────────────────────────────────────
  const quick = el('div.row.wrap', { style: { gap: '12px', marginTop: '16px' } });
  const applyBtn = el('button.btn.btn--primary.grow'); applyBtn.innerHTML = icon('calplus') + '<span>Apply Leave</span>';
  applyBtn.addEventListener('click', () => navigate('#/apply'));
  const calBtn = el('button.btn.btn--ghost.grow'); calBtn.innerHTML = icon('calendar') + '<span>Calendar</span>';
  calBtn.addEventListener('click', () => navigate('#/attendance'));
  quick.append(applyBtn, calBtn);
  screen.append(quick);

  // live wall clock in greeting
  const wall = () => { nowT.textContent = fmtTime(new Date()); };
  wall(); const wallTimer = setInterval(wall, 1000);
  observeDetach(screen, () => { clearInterval(tick); clearInterval(wallTimer); });

  // ── Kick off the first location read ──────────────────────────────────────
  if (!geofence.geofence_enabled) {
    renderGeo('Location check is off', 'idle', 'An admin has disabled the attendance geofence.');
  } else if (!isSupported()) {
    renderGeo('Location not supported', 'bad', 'This browser can\'t share a location, so clock in/out can\'t be verified.');
  } else if (!isSecureOrigin()) {
    renderGeo('Insecure connection', 'bad', 'Location needs HTTPS. Open the app over a secure connection.');
  } else if (record?.status === 'completed') {
    renderGeo('Attendance location', 'idle', `Allowed radius ${geofence.geofence_radius_m} m`, geoRefreshBtn());
  } else {
    const perm = await permissionState();
    if (perm === 'denied') {
      renderGeo('Location permission blocked', 'bad',
        'Allow location access for this site, then tap Retry.', helpBtn());
    } else if (perm === 'granted') {
      locate();                                   // silent, no extra prompt
    } else {
      // Don't fire a permission prompt on load — let the user opt in.
      renderGeo('Location needed to clock in', 'idle',
        `You must be within ${geofence.geofence_radius_m} m of the office.`, geoRefreshBtn('Enable'));
    }
  }

  return screen;
}

// ---- pieces ---------------------------------------------------------------
function firstName(p) { return (p?.full_name || 'there').split(' ')[0]; }

function detailLine(k, v) {
  const r = el('div.row.between', { style: { padding: '7px 0' } });
  r.append(el('span.tiny.muted', k), el('span.small.b', v));
  return r;
}

function showPermissionHelp() {
  const body = el('div');
  body.append(el('p.small.muted', { style: { lineHeight: '1.6', whiteSpace: 'pre-line' } },
    'Clock in and clock out need your location to confirm you are at the office.\n\n' +
    '• iPhone / Safari: Settings → Safari → Location → Ask, then reload this page. Also check Settings → Privacy & Security → Location Services is on.\n' +
    '• Android / Chrome: tap the padlock in the address bar → Permissions → Location → Allow, then reload.\n' +
    '• Desktop Chrome / Edge: click the padlock (or the blocked-location icon) in the address bar → Location → Allow, then reload.\n' +
    '• Make sure your device\'s GPS / location services are switched on.'));
  modal({ title: 'Allow location access', body, actions: [{ label: 'Got it', cls: 'btn--primary' }] });
}

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
