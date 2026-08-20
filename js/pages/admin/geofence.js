import { Settings, GeoLog, Attendance } from '../../lib/data.js?v=20260820a';
import { el, icon, avatar, emptyState } from '../../lib/ui.js?v=20260820a';
import { toastOk, toastErr, modal } from '../../lib/toast.js?v=20260820a';
import { todayYMD, fmtTime, ago, fmtShortDate } from '../../lib/time.js?v=20260820a';
import { fmtDistance } from '../../lib/geo.js?v=20260820a';

const MIN_R = 100, MAX_R = 200;

// Admin view: configure the attendance geofence and inspect every clock in/out
// location attempt (passed and blocked).
export default async function adminGeofence({ refresh }) {
  const [cfg, attempts, todayRecs] = await Promise.all([
    Settings.get(),
    GeoLog.recent(150).catch(() => []),
    Attendance.range(todayYMD(), todayYMD()).catch(() => []),
  ]);

  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Geofence'),
    el('p.muted.small', 'Attendance location, allowed radius, and the clock in/out location log')));

  if (!cfg) {
    screen.append(el('div.card', emptyState('alert', 'Settings not found',
      'The ta_settings row is missing. Run db/schema-v2.sql in the Supabase SQL editor.')));
    return screen;
  }

  // ── Config card ───────────────────────────────────────────────────────────
  const card = el('div.card');
  card.append(el('div.card-title', 'Attendance location'));
  card.append(el('p.small.muted', { style: { margin: '6px 0 16px' } },
    'Employees can only clock in and out while inside this radius. The check runs on the server, so it cannot be skipped from the browser.'));

  const coords = el('div.geo-coords');
  coords.append(
    coordBox('Latitude', cfg.geofence_lat),
    coordBox('Longitude', cfg.geofence_lng),
  );
  card.append(coords);

  const mapLink = el('a.link', {
    href: `https://www.google.com/maps/search/?api=1&query=${cfg.geofence_lat},${cfg.geofence_lng}`,
    target: '_blank', rel: 'noopener noreferrer',
    style: { display: 'inline-block', marginTop: '10px' },
  }, 'Open in Google Maps ↗');
  card.append(mapLink);

  // Radius slider (100–200 m)
  card.append(el('label.small.b', { style: { display: 'block', margin: '20px 0 8px' } }, 'Allowed radius'));
  const rRow = el('div.row', { style: { gap: '14px' } });
  const slider = el('input.range', {
    type: 'range', min: String(MIN_R), max: String(MAX_R), step: '5',
    value: String(cfg.geofence_radius_m), 'aria-label': 'Geofence radius in metres',
  });
  const rVal = el('div.range-val', cfg.geofence_radius_m + ' m');
  rRow.append(slider, rVal);
  card.append(rRow);
  card.append(el('div.row.between', { style: { marginTop: '4px' } },
    el('span.tiny.muted', MIN_R + ' m'), el('span.tiny.muted', MAX_R + ' m')));
  slider.addEventListener('input', () => { rVal.textContent = slider.value + ' m'; markDirty(); });

  // Max GPS accuracy
  card.append(el('label.small.b', { style: { display: 'block', margin: '20px 0 8px' } }, 'Reject GPS readings less accurate than'));
  const accRow = el('div.row', { style: { gap: '14px' } });
  const accI = el('input.input', { type: 'number', min: '20', max: '2000', step: '10', value: String(cfg.max_accuracy_m), style: { maxWidth: '140px' } });
  accRow.append(accI, el('span.small.muted', 'metres — a phone indoors often reports ±100–200 m'));
  card.append(accRow);
  accI.addEventListener('input', markDirty);

  // Enable toggle
  const togRow = el('div.row.between', { style: { marginTop: '20px', padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 'var(--r)' } });
  let enabled = cfg.geofence_enabled;
  togRow.append(el('div',
    el('div.small.b', 'Enforce geofence'),
    el('div.tiny.muted', 'Turn off only in an emergency — clock in/out will then be allowed from anywhere.')));
  const sw = toggle(enabled, (v) => { enabled = v; markDirty(); });
  togRow.append(sw);
  card.append(togRow);

  const save = el('button.btn.btn--primary.btn--block', { style: { marginTop: '18px' } }, 'Save geofence settings');
  card.append(save);
  const dirty = el('p.tiny.muted.center-text', { style: { marginTop: '8px' } }, 'No unsaved changes');
  card.append(dirty);

  function markDirty() {
    const changed = Number(slider.value) !== cfg.geofence_radius_m
      || Number(accI.value) !== cfg.max_accuracy_m
      || enabled !== cfg.geofence_enabled;
    dirty.textContent = changed ? 'Unsaved changes' : 'No unsaved changes';
    dirty.style.color = changed ? 'var(--warn)' : 'var(--muted)';
  }

  save.addEventListener('click', async () => {
    const radius = Number(slider.value);
    const acc = Number(accI.value);
    if (!Number.isInteger(radius) || radius < MIN_R || radius > MAX_R) {
      return toastErr(`The radius must be between ${MIN_R} and ${MAX_R} metres.`);
    }
    if (!Number.isInteger(acc) || acc < 20 || acc > 2000) {
      return toastErr('Max GPS accuracy must be between 20 and 2000 metres.');
    }
    save.disabled = true; save.textContent = 'Saving…';
    try {
      await Settings.setGeofence({ radius, enabled, maxAccuracy: acc });
      toastOk(`Geofence saved — radius ${radius} m`);
      refresh();
    } catch (e) {
      toastErr(e.message);
      save.disabled = false; save.textContent = 'Save geofence settings';
    }
  });
  screen.append(card);

  // ── Today's clock in/out locations ────────────────────────────────────────
  screen.append(el('div.section-h', el('h2', 'Today\'s clock in / out locations')));
  if (!todayRecs.length) {
    screen.append(el('div.card', emptyState('pin', 'Nobody has clocked in today')));
  } else {
    const wrap = el('div.table-wrap');
    const t = el('table.tbl');
    t.innerHTML = `<thead><tr>
      <th>Employee</th><th>Clock in</th><th>In · distance</th><th>Clock out</th><th>Out · distance</th><th>Radius</th>
    </tr></thead>`;
    const tb = el('tbody');
    for (const r of todayRecs) {
      const p = r.ta_profiles || {};
      const tr = el('tr');
      tr.append(el('td', el('div.row', { style: { gap: '10px' } },
        avatar(p, 'sm'), el('div', el('div.b.small', p.full_name || 'Employee'), el('div.tiny.muted', p.department || '—')))));
      tr.append(el('td', el('span.small', r.clock_in ? fmtTime(r.clock_in) : '—')));
      tr.append(el('td', distCell(r.clock_in_distance_m, r.clock_in_geofence_ok, r.clock_in_lat, r.clock_in_lng)));
      tr.append(el('td', el('span.small', r.clock_out ? fmtTime(r.clock_out) : '—')));
      tr.append(el('td', distCell(r.clock_out_distance_m, r.clock_out_geofence_ok, r.clock_out_lat, r.clock_out_lng)));
      tr.append(el('td', el('span.tiny.muted', (r.clock_in_radius_m || cfg.geofence_radius_m) + ' m')));
      tb.append(tr);
    }
    t.append(tb);
    wrap.append(t);
    screen.append(wrap);
  }

  // ── Full attempt log ──────────────────────────────────────────────────────
  const passed = attempts.filter(a => a.passed).length;
  const blocked = attempts.length - passed;
  screen.append(el('div.section-h',
    el('h2', 'Location attempt log'),
    el('span.tiny.muted', `${passed} passed · ${blocked} blocked (last ${attempts.length})`)));

  let logFilter = 'all';
  const seg = el('div.seg', { style: { marginBottom: '14px' } });
  [['all', 'All'], ['blocked', `Blocked (${blocked})`], ['passed', `Passed (${passed})`]].forEach(([v, label]) => {
    const b = el('button' + (v === logFilter ? '.on' : ''), label);
    b.addEventListener('click', () => { logFilter = v; [...seg.children].forEach(x => x.classList.remove('on')); b.classList.add('on'); drawLog(); });
    seg.append(b);
  });
  screen.append(seg);

  const logWrap = el('div');
  screen.append(logWrap);

  function drawLog() {
    const rows = logFilter === 'all' ? attempts
      : attempts.filter(a => (logFilter === 'passed') === !!a.passed);
    logWrap.replaceChildren();
    if (!rows.length) { logWrap.append(el('div.card', emptyState('pin', 'No attempts recorded'))); return; }

    const wrap = el('div.table-wrap');
    const t = el('table.tbl');
    t.innerHTML = `<thead><tr>
      <th>When</th><th>Employee</th><th>Action</th><th>Result</th><th>Distance</th>
      <th>Accuracy</th><th>Radius</th><th>Coordinates</th>
    </tr></thead>`;
    const tb = el('tbody');
    for (const a of rows) {
      const p = a.ta_profiles || {};
      const tr = el('tr');
      tr.append(el('td', el('div', el('div.small', ago(a.created_at)), el('div.tiny.muted', fmtTime(a.created_at)))));
      tr.append(el('td', el('span.small.b', p.full_name || '—')));
      tr.append(el('td', el('span.pill.pill--plain', a.action === 'clock_in' ? 'Clock in' : 'Clock out')));
      tr.append(el('td', el('div',
        el('span.pill.pill--' + (a.passed ? 'approved' : 'denied'), a.passed ? 'Passed' : 'Blocked'),
        el('div.tiny.muted', { style: { marginTop: '3px' } }, a.reason || ''))));
      tr.append(el('td', el('span.small' + (a.passed ? '' : '.b'), a.distance_m != null ? fmtDistance(Number(a.distance_m)) : '—')));
      tr.append(el('td', el('span.tiny.muted', a.accuracy_m != null ? '±' + Math.round(a.accuracy_m) + ' m' : '—')));
      tr.append(el('td', el('span.tiny.muted', a.radius_m != null ? a.radius_m + ' m' : '—')));
      tr.append(el('td', coordCell(a.lat, a.lng)));
      tb.append(tr);
    }
    t.append(tb);
    wrap.append(t);
    logWrap.append(wrap);
  }
  drawLog();

  return screen;
}

// ---- pieces ---------------------------------------------------------------
function coordBox(label, value) {
  const b = el('div.geo-coord');
  b.append(el('div.tiny.muted', label), el('div.cv', String(value)));
  return b;
}

function distCell(dist, ok, lat, lng) {
  if (dist == null) return el('span.tiny.muted', '—');
  const box = el('div');
  box.append(el('span.pill.pill--' + (ok === false ? 'denied' : 'approved'), fmtDistance(Number(dist))));
  if (lat != null && lng != null) box.append(coordCell(lat, lng));
  return box;
}

function coordCell(lat, lng) {
  if (lat == null || lng == null) return el('span.tiny.muted', '—');
  const a = el('a.tiny.muted', {
    href: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
    target: '_blank', rel: 'noopener noreferrer',
    style: { display: 'block', marginTop: '3px', textDecoration: 'underline' },
  }, `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`);
  return a;
}

function toggle(on, onChange) {
  const sw = el('div', { style: {
    width: '46px', height: '27px', borderRadius: '99px', padding: '3px', transition: 'background .2s',
    background: on ? 'var(--teal)' : 'var(--line)', cursor: 'pointer', flex: 'none' } });
  const knob = el('div', { style: { width: '21px', height: '21px', borderRadius: '50%', background: '#fff',
    transition: 'transform .2s', transform: on ? 'translateX(19px)' : 'none', boxShadow: '0 1px 3px rgba(0,0,0,.2)' } });
  sw.append(knob);
  let state = on;
  sw.addEventListener('click', () => {
    state = !state;
    sw.style.background = state ? 'var(--teal)' : 'var(--line)';
    knob.style.transform = state ? 'translateX(19px)' : 'none';
    onChange(state);
  });
  return sw;
}
