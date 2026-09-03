// Admin → Leave Permissions.
//
// A leave permission is time away DURING a working day — not vacation. Every
// employee gets a monthly allowance (3 by default); those are approved by the
// database the instant they are submitted and never appear here as pending.
// Anything beyond the allowance lands here marked "Requires approval" and
// waits for a decision.
//
// The decision itself is ta_review_permission(), which refuses anyone who is
// not an admin. Employees have no INSERT or UPDATE grant on the table at all,
// so a status can only ever be changed from this screen.
import { Permissions, PERMISSION_LABEL, PERMISSION_PILL } from '../../lib/data.js?v=20260903a';
import { el, icon, avatar, emptyState } from '../../lib/ui.js?v=20260903a';
import { toastOk, toastErr, modal } from '../../lib/toast.js?v=20260903a';
import { fmtShortDate, ago, MONTHS } from '../../lib/time.js?v=20260903a';
import { hm12, mins } from '../../lib/money.js?v=20260903a';

export default async function adminPermissions({ refresh } = {}) {
  const all = await Permissions.all();

  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Leave Permissions'),
    el('p.muted.small', 'Permission to step out during a working day. The first few each calendar month are '
      + 'approved automatically; only the ones beyond an employee\'s allowance need you.')));

  const pending = all.filter(r => r.status === 'pending');

  // ── Counters ──────────────────────────────────────────────────────────────
  const kpiGrid = el('div.kpi-grid', { style: { marginBottom: '18px' } });
  const thisMonth = all.filter(r => sameMonth(r.permission_date, new Date()));
  kpiGrid.append(
    kpi('inbox', 'warn', pending.length, 'Requires approval'),
    kpi('checkcircle', 'teal', thisMonth.filter(r => r.status === 'approved').length, 'Approved this month'),
    kpi('clock', 'blue', mins(thisMonth.filter(r => r.status === 'approved')
      .reduce((s, r) => s + r.duration_minutes, 0)), 'Time out this month'),
    kpi('xcircle', 'danger', thisMonth.filter(r => r.status === 'rejected').length, 'Rejected this month'),
  );
  screen.append(kpiGrid);

  // ── Controls ──────────────────────────────────────────────────────────────
  const controls = el('div.row.wrap', { style: { gap: '12px', marginBottom: '14px' } });
  const search = el('div.input-icon', { style: { maxWidth: '300px', flex: '1' } });
  search.innerHTML = `<span class="i-lead">${icon('search')}</span>`;
  const sInput = el('input.input', { placeholder: 'Search employees…' });
  search.append(sInput);

  let flt = pending.length ? 'pending' : 'all';
  const seg = el('div.seg');
  const FILTERS = [
    ['pending', 'Requires approval'],
    ['approved', 'Approved'],
    ['closed', 'Rejected / cancelled'],
    ['all', 'All'],
  ];
  for (const [v, l] of FILTERS) {
    const b = el('button' + (v === flt ? '.on' : ''), l);
    b.addEventListener('click', () => { flt = v; [...seg.children].forEach(x => x.classList.remove('on')); b.classList.add('on'); draw(); });
    seg.append(b);
  }
  controls.append(search, seg);
  screen.append(controls);

  const wrap = el('div.table-wrap');
  const table = el('table.tbl');
  wrap.append(table);
  screen.append(wrap);

  function apply() {
    const q = sInput.value.trim().toLowerCase();
    return all.filter((r) => {
      if (flt === 'pending' && r.status !== 'pending') return false;
      if (flt === 'approved' && r.status !== 'approved') return false;
      if (flt === 'closed' && !['rejected', 'cancelled'].includes(r.status)) return false;
      if (!q) return true;
      const p = r.ta_profiles || {};
      return [p.full_name, p.department, p.position, r.reason].some(v => (v || '').toLowerCase().includes(q));
    });
  }

  function draw() {
    const list = apply();
    table.replaceChildren();
    const thead = el('thead');
    thead.innerHTML = '<tr><th>Employee</th><th>Date</th><th>From</th><th>To</th><th>Duration</th>'
      + '<th>Reason</th><th>Status</th><th>Approved by</th><th></th></tr>';
    table.append(thead);

    const tbody = el('tbody');
    if (!list.length) {
      const tr = el('tr'); const td = el('td', { colspan: '9' });
      td.append(emptyState('checkcircle', flt === 'pending' ? 'Nothing needs your approval' : 'No leave permissions here',
        flt === 'pending' ? 'Permissions inside an employee\'s monthly allowance are approved automatically.' : null));
      tr.append(td); tbody.append(tr);
    }
    for (const r of list) {
      const p = r.ta_profiles || {};
      const tr = el('tr');

      const who = el('td');
      const line = el('div.row', { style: { gap: '10px' } });
      line.append(avatar(p, 'sm'), el('div',
        el('div.small.b', p.full_name || 'Employee'),
        el('div.tiny.muted', p.position || p.department || '—')));
      who.append(line);
      tr.append(who);

      tr.append(el('td', { style: { whiteSpace: 'nowrap' } },
        el('div.small.b', fmtShortDate(r.permission_date)),
        el('div.tiny.muted', 'asked ' + ago(r.created_at))));
      tr.append(el('td.tiny', hm12(r.start_time)));
      tr.append(el('td.tiny', hm12(r.end_time)));
      tr.append(el('td', { style: { fontWeight: '600', whiteSpace: 'nowrap' } }, mins(r.duration_minutes)));
      tr.append(el('td.tiny', { style: { maxWidth: '220px' } }, r.reason || '—'));

      const st = el('td');
      st.append(el('span.pill.pill--' + (PERMISSION_PILL[r.status] || 'plain'), PERMISSION_LABEL[r.status] || r.status));
      if (r.status === 'pending') {
        st.append(el('div.tiny.muted', { style: { marginTop: '4px' } },
          `beyond their ${r.monthly_limit} / month`));
      }
      tr.append(st);

      tr.append(el('td.tiny', r.status === 'pending' ? '—'
        : r.approval_type === 'automatic' ? 'Automatic (within allowance)'
        : r.decided?.full_name ? `Admin · ${r.decided.full_name}`
        : r.approval_type === 'admin' ? 'Admin' : '—'));

      const act = el('td');
      const bar = el('div.row', { style: { gap: '6px' } });
      if (r.status === 'pending') {
        const yes = el('button.btn.btn--primary.btn--sm', 'Approve');
        yes.addEventListener('click', () => decide(r, 'approved', refresh));
        const no = el('button.btn.btn--pill-line.btn--sm', 'Reject');
        no.addEventListener('click', () => decide(r, 'rejected', refresh));
        bar.append(yes, no);
      }
      const hist = el('button.btn.btn--ghost.btn--sm', 'History');
      hist.addEventListener('click', () => showHistory(p, r.employee_id, all));
      bar.append(hist);
      act.append(bar);
      tr.append(act);

      tbody.append(tr);
    }
    table.append(tbody);
  }

  sInput.addEventListener('input', draw);
  draw();

  screen.append(el('p.tiny.muted', { style: { marginTop: '12px' } },
    'An approved permission never counts as an absence and costs nothing unless a permission deduction '
    + 'is switched on for that employee in Salary & Attendance Rules.'));

  return screen;
}

function decide(r, decision, onDone) {
  const p = r.ta_profiles || {};
  const body = el('div');
  body.append(el('p.small.muted', { style: { lineHeight: '1.6' } },
    `${p.full_name || 'This employee'} asked for ${mins(r.duration_minutes)} on `
    + `${fmtShortDate(r.permission_date)} (${hm12(r.start_time)} – ${hm12(r.end_time)}). `
    + `They have already used their ${r.monthly_limit} permissions for that month.`));
  if (r.reason) body.append(el('p.small', { style: { marginTop: '10px' } }, `"${r.reason}"`));
  const note = el('input.input', { placeholder: 'Note for the employee (optional)', style: { marginTop: '12px' } });
  body.append(note);

  modal({
    title: decision === 'approved' ? 'Approve this permission?' : 'Reject this permission?',
    body,
    actions: [
      { label: 'Cancel', cls: 'btn--pill-line' },
      {
        label: decision === 'approved' ? 'Approve' : 'Reject',
        cls: decision === 'approved' ? 'btn--primary' : 'btn--danger',
        onClick: async (close) => {
          try {
            await Permissions.review(r.id, decision, note.value.trim() || null);
            close();
            toastOk(decision === 'approved' ? 'Permission approved' : 'Permission rejected');
            onDone?.();
          } catch (e) { toastErr(e.message); }
        },
      },
    ],
  });
}

// The employee's complete permission history, newest month first.
function showHistory(profile, empId, all) {
  const rows = all.filter(r => r.employee_id === empId)
    .sort((a, b) => (a.permission_date < b.permission_date ? 1 : -1));

  const body = el('div');
  if (!rows.length) {
    body.append(emptyState('calendar', 'No permissions yet'));
  } else {
    // Group by calendar month so the 3-per-month allowance is legible.
    const byMonth = {};
    for (const r of rows) {
      const key = r.permission_date.slice(0, 7);
      (byMonth[key] ||= []).push(r);
    }
    for (const [key, list] of Object.entries(byMonth)) {
      const [y, m] = key.split('-');
      const used = list.filter(r => r.status === 'approved').length;
      const limit = list[0]?.monthly_limit ?? 3;
      const head = el('div.row.between', { style: { marginTop: '14px', marginBottom: '6px', gap: '10px' } });
      head.append(el('span.small.b', `${MONTHS[Number(m) - 1]} ${y}`),
        el('span.pill.pill--' + (used >= limit ? 'pending' : 'approved'), { style: { height: '22px' } },
          `Used ${used} / ${limit}`));
      body.append(head);
      for (const r of list) {
        const row = el('div.lrow');
        row.append(el('div.grow',
          el('div.name', fmtShortDate(r.permission_date)),
          el('div.meta', `${hm12(r.start_time)} – ${hm12(r.end_time)} · ${mins(r.duration_minutes)}`
            + (r.reason ? ` · ${r.reason}` : ''))));
        row.append(el('span.pill.pill--' + (PERMISSION_PILL[r.status] || 'plain'),
          r.status === 'approved' && r.approval_type === 'automatic' ? 'Auto approved'
            : PERMISSION_LABEL[r.status] || r.status));
        body.append(row);
      }
    }
  }
  modal({
    title: (profile.full_name || 'Employee') + ' · permissions',
    body: el('div', { style: { maxHeight: '60vh', overflowY: 'auto' } }, body),
    actions: [{ label: 'Close', cls: 'btn--pill-line' }],
  });
}

function sameMonth(dateStr, ref) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
}

function kpi(ic, tone, value, label) {
  const c = el('div.kpi');
  c.append(el('div.ic.ic--' + tone, { html: icon(ic) }));
  c.append(el('div', el('div.v', { style: { fontSize: '17px' } }, String(value)), el('div.k', label)));
  return c;
}
