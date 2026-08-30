import { Profiles, RestDays } from '../../lib/data.js?v=20260830a';
import { el, icon, avatar, pill, emptyState } from '../../lib/ui.js?v=20260830a';
import { toastOk, toastErr, modal } from '../../lib/toast.js?v=20260830a';
import { ago, fmtShortDate, fmtDayMon } from '../../lib/time.js?v=20260830a';

// Admin view: rest-day requests + every employee's rest-day balance.
export default async function adminRestDays({ refresh }) {
  const [people, all, balances] = await Promise.all([
    Profiles.all(), RestDays.all(), RestDays.balances(),
  ]);
  const employees = people.filter(p => p.role === 'employee');
  const balByEmp = Object.fromEntries(balances.map(b => [b.employee_id, b]));
  const pendingByEmp = {};
  for (const r of all) if (r.status === 'pending') pendingByEmp[r.employee_id] = (pendingByEmp[r.employee_id] || 0) + r.days_count;

  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Rest Days'),
    el('p.muted.small', 'Review rest-day requests and manage each employee\'s rest-day balance')));

  const counts = {
    pending: all.filter(r => r.status === 'pending').length,
    approved: all.filter(r => r.status === 'approved').length,
    denied: all.filter(r => r.status === 'denied').length,
  };
  const kpis = el('div.kpi-grid', { style: { marginBottom: '26px' } });
  kpis.append(
    kpi('clock', 'warn', counts.pending, 'Pending requests'),
    kpi('checkcircle', 'teal', counts.approved, 'Approved'),
    kpi('xcircle', 'danger', counts.denied, 'Denied'),
    kpi('moon', 'blue', balances.reduce((s, b) => s + b.remaining_days, 0), 'Team days remaining'),
  );
  screen.append(kpis);

  // ── Requests ──────────────────────────────────────────────────────────────
  let filter = 'pending';
  const seg = el('div.seg', { style: { marginBottom: '18px' } });
  [['pending', 'Pending'], ['approved', 'Approved'], ['denied', 'Denied'], ['all', 'All']].forEach(([v, label]) => {
    const n = v === 'all' ? all.length : counts[v];
    const b = el('button' + (v === filter ? '.on' : ''), `${label} (${n})`);
    b.addEventListener('click', () => { filter = v; [...seg.children].forEach(x => x.classList.remove('on')); b.classList.add('on'); draw(); });
    seg.append(b);
  });
  screen.append(el('div.section-h', el('h2', 'Rest-day requests')));
  screen.append(seg);

  const grid = el('div', { style: { display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fill,minmax(330px,1fr))' } });
  screen.append(grid);

  function draw() {
    const rows = filter === 'all' ? all : all.filter(r => r.status === filter);
    grid.replaceChildren();
    if (!rows.length) { grid.append(el('div.card', emptyState('moon', 'Nothing here', `No ${filter} rest-day requests.`))); return; }
    for (const r of rows) grid.append(requestCard(r));
  }
  draw();

  // ── Balances table ────────────────────────────────────────────────────────
  screen.append(el('div.section-h', el('h2', 'Rest-day balances')));
  const wrap = el('div.table-wrap');
  const t = el('table.tbl');
  t.innerHTML = `<thead><tr>
      <th>Employee</th><th>Total</th><th>Used</th><th>Remaining</th><th>Pending</th><th>Available</th><th></th>
    </tr></thead>`;
  const tb = el('tbody');
  for (const p of employees) {
    const b = balByEmp[p.id];
    const pend = pendingByEmp[p.id] || 0;
    const remaining = b?.remaining_days ?? 0;
    const avail = Math.max(0, remaining - pend);

    const tr = el('tr');
    const who = el('td');
    who.append(el('div.row', { style: { gap: '10px' } },
      avatar(p, 'sm'), el('div', el('div.b.small', p.full_name), el('div.tiny.muted', p.department || '—'))));
    tr.append(who);
    tr.append(el('td', el('span.small.b', String(b?.total_days ?? '—'))));
    tr.append(el('td', el('span.small', String(b?.used_days ?? '—'))));
    tr.append(el('td', el('span.small', String(remaining))));
    tr.append(el('td', el('span.small.muted', pend ? String(pend) : '—')));
    tr.append(el('td', el('span.pill.pill--' + (avail > 0 ? 'present' : 'denied'), String(avail))));

    const act = el('td');
    const edit = el('button.btn.btn--pill-line.btn--sm', 'Set total');
    edit.addEventListener('click', () => editBalance(p, b));
    act.append(edit);
    tr.append(act);
    tb.append(tr);
  }
  if (!employees.length) tb.append(el('tr', el('td', { colspan: '7' }, emptyState('users', 'No employees yet'))));
  t.append(tb);
  wrap.append(t);
  screen.append(wrap);

  // ---- pieces -------------------------------------------------------------
  function requestCard(r) {
    const p = r.ta_profiles || {};
    const b = balByEmp[r.employee_id];
    const c = el('div.card');
    const head = el('div.row.between', { style: { marginBottom: '12px' } });
    const who = el('div.row', { style: { gap: '10px' } });
    who.append(avatar(p, 'sm'), el('div', el('div.b', p.full_name || 'Employee'), el('div.tiny.muted', p.department || '—')));
    head.append(who, pill(r.status));
    c.append(head);

    const meta = el('div', { style: { display: 'grid', gap: '8px', marginBottom: '12px' } });
    meta.append(
      metaRow('moon', `${r.days_count} rest day${r.days_count > 1 ? 's' : ''}`),
      metaRow('calendar', `${fmtShortDate(r.start_date)} → ${fmtShortDate(r.end_date)}`),
      metaRow('clock', `Requested ${ago(r.created_at)}`),
      metaRow('activity', `Balance before: ${r.balance_before}` +
        (r.balance_after != null ? ` · after: ${r.balance_after}` : b ? ` · now: ${b.remaining_days}/${b.total_days}` : '')),
    );
    c.append(meta);

    const chips = el('div.row.wrap', { style: { gap: '6px', marginBottom: '12px' } });
    for (const d of (r.dates || [])) chips.append(el('span.pill.pill--plain', { style: { height: '24px', fontSize: '11.5px' } }, fmtDayMon(d)));
    c.append(chips);

    if (r.reason) c.append(el('p.small.muted', { style: { marginBottom: '12px', background: 'var(--surface-2)', padding: '10px 12px', borderRadius: 'var(--r-sm)' } }, '“' + r.reason + '”'));
    if (r.admin_note) c.append(el('p.tiny', { style: { marginBottom: '12px', color: 'var(--ink-2)' } }, 'Note: ' + r.admin_note));

    if (r.status === 'pending') {
      const short = b && r.days_count > b.remaining_days;
      if (short) {
        c.append(el('p.tiny', { style: { marginBottom: '10px', color: 'var(--danger)', fontWeight: '600' } },
          `Insufficient balance — only ${b.remaining_days} day(s) remain. Approving will be refused by the server.`));
      }
      const bar = el('div.row', { style: { gap: '10px' } });
      const no = el('button.btn.btn--danger.grow.btn--sm', 'Deny');
      const yes = el('button.btn.btn--primary.grow.btn--sm', 'Approve');
      no.addEventListener('click', () => decide(r, 'denied', [no, yes]));
      yes.addEventListener('click', () => decide(r, 'approved', [no, yes]));
      bar.append(no, yes);
      c.append(bar);
    }
    return c;
  }

  function decide(r, decision, btns) {
    const noteI = el('textarea.textarea', {
      placeholder: decision === 'approved' ? 'Optional note for the employee…' : 'Why is this being denied? (optional)',
      maxlength: '400', style: { minHeight: '84px' },
    });
    const body = el('div');
    body.append(el('p.small.muted', { style: { marginBottom: '12px', lineHeight: '1.6' } },
      decision === 'approved'
        ? `${r.days_count} day(s) will be deducted from ${(r.ta_profiles?.full_name || 'this employee')}'s rest-day balance.`
        : 'No days are deducted. The employee keeps their full balance.'),
      noteI);

    modal({
      title: decision === 'approved' ? 'Approve rest days?' : 'Deny rest days?',
      body,
      actions: [
        { label: 'Cancel', cls: 'btn--pill-line' },
        {
          label: decision === 'approved' ? 'Approve' : 'Deny',
          cls: decision === 'approved' ? 'btn--primary' : 'btn--danger',
          onClick: async (close) => {
            close();
            btns.forEach(x => x.disabled = true);
            try {
              await RestDays.review(r.id, decision, noteI.value.trim() || null);
              toastOk(decision === 'approved' ? 'Rest days approved' : 'Rest days denied');
              refresh();
            } catch (e) { toastErr(e.message); btns.forEach(x => x.disabled = false); }
          },
        },
      ],
    });
  }

  function editBalance(p, b) {
    const input = el('input.input', { type: 'number', min: String(b?.used_days ?? 0), max: '365', value: String(b?.total_days ?? 4) });
    const body = el('div');
    body.append(el('p.small.muted', { style: { marginBottom: '12px' } },
      `${p.full_name} has used ${b?.used_days ?? 0} rest day(s). The total can't go below that.`), input);
    modal({
      title: 'Set rest-day total',
      body,
      actions: [
        { label: 'Cancel', cls: 'btn--pill-line' },
        {
          label: 'Save', cls: 'btn--primary',
          onClick: async (close) => {
            const v = parseInt(input.value, 10);
            if (!Number.isInteger(v) || v < 0) return toastErr('Enter a whole number of days');
            close();
            try { await RestDays.setTotal(p.id, v); toastOk('Rest-day total updated'); refresh(); }
            catch (e) { toastErr(e.message); }
          },
        },
      ],
    });
  }

  return screen;
}

function metaRow(ic, text) {
  const r = el('div.row', { style: { gap: '9px' } });
  const i = el('span', { style: { color: 'var(--muted)', display: 'flex' }, html: icon(ic, 'ic-sm') });
  r.append(i, el('span.small', text));
  return r;
}

function kpi(ic, tone, value, label) {
  const c = el('div.kpi');
  c.append(el('div.ic.ic--' + tone, { html: icon(ic) }));
  c.append(el('div', el('div.v', String(value)), el('div.k', label)));
  return c;
}
