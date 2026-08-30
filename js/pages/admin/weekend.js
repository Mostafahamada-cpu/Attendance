import { Profiles, Weekend } from '../../lib/data.js?v=20260830b';
import { el, icon, avatar, emptyState } from '../../lib/ui.js?v=20260830b';
import { toastOk, toastErr, modal } from '../../lib/toast.js?v=20260830b';
import { ago, DOW_FULL, DOW } from '../../lib/time.js?v=20260830b';

// Admin view: weekend-change usage per employee + approve/reject the second
// (approval-requiring) change. The first change never lands here — it is
// auto-approved by ta_request_weekend_change().
export default async function adminWeekend({ refresh }) {
  const [people, all] = await Promise.all([Profiles.all(), Weekend.all()]);
  const employees = people.filter(p => p.role === 'employee');
  const byEmp = {};
  for (const r of all) (byEmp[r.employee_id] ||= []).push(r);

  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Weekend Changes'),
    el('p.muted.small', `Every employee gets ${Weekend.MAX} weekend changes. The first is automatic; the second needs your approval.`)));

  const pending = all.filter(r => r.status === 'pending');

  // ── KPI row ───────────────────────────────────────────────────────────────
  const kpis = el('div.kpi-grid', { style: { marginBottom: '26px' } });
  kpis.append(
    kpi('clock', 'warn', pending.length, 'Awaiting approval'),
    kpi('check', 'teal', all.filter(r => r.status === 'auto_approved').length, 'Auto-approved (1st)'),
    kpi('checkcircle', 'blue', all.filter(r => r.status === 'approved').length, 'Approved (2nd)'),
    kpi('xcircle', 'danger', all.filter(r => r.status === 'rejected').length, 'Rejected'),
  );
  screen.append(kpis);

  // ── Pending approvals ─────────────────────────────────────────────────────
  screen.append(el('div.section-h', el('h2', 'Second-change requests awaiting approval')));
  const pendWrap = el('div', { style: { display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fill,minmax(330px,1fr))' } });
  if (!pending.length) {
    pendWrap.append(el('div.card', emptyState('check', 'Nothing to review', 'Second weekend-change requests will appear here.')));
  } else {
    for (const r of pending) pendWrap.append(pendingCard(r));
  }
  screen.append(pendWrap);

  // ── Usage table ───────────────────────────────────────────────────────────
  screen.append(el('div.section-h', el('h2', 'Weekend-change usage')));
  const wrap = el('div.table-wrap');
  const t = el('table.tbl');
  t.innerHTML = `<thead><tr>
      <th>Employee</th><th>Used</th><th>1st change</th><th>2nd change</th><th>Current weekend</th>
    </tr></thead>`;
  const tb = el('tbody');
  if (!employees.length) {
    tb.append(el('tr', el('td', { colspan: '5' }, emptyState('users', 'No employees yet'))));
  }
  for (const p of employees) {
    const rows = byEmp[p.id] || [];
    const used = Weekend.usedFrom(rows);
    const first = rows.find(r => r.change_number === 1 && r.status !== 'rejected');
    const second = rows.find(r => r.change_number === 2 && r.status !== 'rejected');
    const latest = [...rows].filter(r => r.applied).sort((a, b) => new Date(b.applied_at) - new Date(a.applied_at))[0];

    const tr = el('tr');
    const who = el('td');
    const w = el('div.row', { style: { gap: '10px' } });
    w.append(avatar(p, 'sm'), el('div', el('div.b.small', p.full_name), el('div.tiny.muted', p.department || '—')));
    who.append(w);
    tr.append(who);
    tr.append(el('td', el('span.pill.pill--' + (used >= Weekend.MAX ? 'denied' : used === 1 ? 'pending' : 'present'),
      `${used} / ${Weekend.MAX}`)));
    tr.append(el('td', slotCell(first, rows.filter(r => r.change_number === 1))));
    tr.append(el('td', slotCell(second, rows.filter(r => r.change_number === 2))));
    tr.append(el('td', el('span.small', latest ? labelDays(latest.requested_days) : '—')));
    tb.append(tr);
  }
  t.append(tb);
  wrap.append(t);
  screen.append(wrap);

  // ── All requests ──────────────────────────────────────────────────────────
  screen.append(el('div.section-h', el('h2', 'All weekend-change requests')));
  if (!all.length) {
    screen.append(el('div.card', emptyState('swap', 'No weekend changes recorded yet')));
  } else {
    const list = el('div.list');
    for (const r of all) list.append(historyRow(r));
    screen.append(list);
  }

  // ---- pieces -------------------------------------------------------------
  function slotCell(live, allForSlot) {
    if (live) {
      const box = el('div');
      box.append(statusPill(live.status));
      box.append(el('div.tiny.muted', { style: { marginTop: '4px' } }, ago(live.requested_at)));
      return box;
    }
    const rejected = allForSlot.filter(r => r.status === 'rejected').length;
    return el('span.tiny.muted', rejected ? `Available (${rejected} rejected)` : 'Available');
  }

  function pendingCard(r) {
    const p = r.ta_profiles || {};
    const c = el('div.card');
    const head = el('div.row.between', { style: { marginBottom: '12px' } });
    const who = el('div.row', { style: { gap: '10px' } });
    who.append(avatar(p, 'sm'), el('div', el('div.b', p.full_name || 'Employee'), el('div.tiny.muted', p.department || '—')));
    head.append(who, el('span.pill.pill--pending', `Change #${r.change_number}`));
    c.append(head);

    c.append(el('div.row', { style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' } },
      el('span.pill.pill--plain', labelDays(r.original_days) || 'none'),
      el('span.arr', { html: icon('arrowR', 'ic-sm') }),
      el('span.pill.pill--present', labelDays(r.requested_days))));

    c.append(el('div.tiny.muted', `Requested ${ago(r.requested_at)}`));
    if (r.reason) c.append(el('p.small.muted', { style: { marginTop: '10px', background: 'var(--surface-2)', padding: '10px 12px', borderRadius: 'var(--r-sm)' } }, '“' + r.reason + '”'));

    const bar = el('div.row', { style: { gap: '10px', marginTop: '14px' } });
    const no = el('button.btn.btn--danger.grow.btn--sm', 'Reject');
    const yes = el('button.btn.btn--primary.grow.btn--sm', 'Approve');
    no.addEventListener('click', () => decide(r, 'rejected', [no, yes]));
    yes.addEventListener('click', () => decide(r, 'approved', [no, yes]));
    bar.append(no, yes);
    c.append(bar);
    return c;
  }

  function decide(r, decision, btns) {
    const noteI = el('textarea.textarea', {
      placeholder: decision === 'approved' ? 'Optional note for the employee…' : 'Why is this being rejected? (optional)',
      maxlength: '400', style: { minHeight: '84px' },
    });
    const body = el('div');
    body.append(el('p.small.muted', { style: { marginBottom: '12px', lineHeight: '1.6' } },
      decision === 'approved'
        ? `${(r.ta_profiles?.full_name || 'This employee')}'s weekend will change to ${labelDays(r.requested_days)} immediately, and their weekly off-days will be updated.`
        : `The request stays on record as rejected. It does NOT consume one of their ${Weekend.MAX} changes, so they may submit a different one.`),
      noteI);

    modal({
      title: decision === 'approved' ? 'Approve weekend change?' : 'Reject weekend change?',
      body,
      actions: [
        { label: 'Cancel', cls: 'btn--pill-line' },
        {
          label: decision === 'approved' ? 'Approve' : 'Reject',
          cls: decision === 'approved' ? 'btn--primary' : 'btn--danger',
          onClick: async (close) => {
            close();
            btns.forEach(b => b.disabled = true);
            try {
              await Weekend.review(r.id, decision, noteI.value.trim() || null);
              toastOk(decision === 'approved' ? 'Weekend change approved' : 'Weekend change rejected');
              refresh();
            } catch (e) { toastErr(e.message); btns.forEach(b => b.disabled = false); }
          },
        },
      ],
    });
  }

  return screen;
}

function historyRow(r) {
  const p = r.ta_profiles || {};
  const row = el('div.lrow');
  row.append(avatar(p, 'sm'));
  row.append(el('div.grow',
    el('div.name', p.full_name || 'Employee'),
    el('div.meta', `#${r.change_number} · ${labelDays(r.original_days) || 'none'} → ${labelDays(r.requested_days)}`)));
  const right = el('div', { style: { textAlign: 'right' } });
  right.append(el('div.tiny.muted', ago(r.requested_at)));
  row.append(right, statusPill(r.status));
  return row;
}

function statusPill(status) {
  const map = {
    auto_approved: ['approved', 'Auto-approved'],
    approved: ['approved', 'Approved'],
    pending: ['pending', 'Pending'],
    rejected: ['denied', 'Rejected'],
  };
  const [cls, label] = map[status] || ['plain', status];
  return el('span.pill.pill--' + cls, label);
}

function labelDays(days) {
  if (!days || !days.length) return '';
  return [...days].sort((a, b) => a - b).map(d => DOW[d]).join(', ');
}

function kpi(ic, tone, value, label) {
  const c = el('div.kpi');
  c.append(el('div.ic.ic--' + tone, { html: icon(ic) }));
  c.append(el('div', el('div.v', String(value)), el('div.k', label)));
  return c;
}
