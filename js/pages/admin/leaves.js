import { Leaves, Balances } from '../../lib/data.js?v=20260813c';
import { el, icon, avatar, pill, emptyState } from '../../lib/ui.js?v=20260813c';
import { toastOk, toastErr, confirmDialog } from '../../lib/toast.js?v=20260813c';
import { fmtShortDate, ago } from '../../lib/time.js?v=20260813c';

const TYPE_LABEL = { casual: 'Casual', medical: 'Medical', planned: 'Planned' };

export default async function adminLeaves({ refresh }) {
  const [all, balances] = await Promise.all([Leaves.all(), Balances.all()]);
  const balIdx = {};
  for (const b of balances) balIdx[b.employee_id + '_' + b.leave_type] = b;

  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Leave Requests'),
    el('p.muted.small', 'Review and decide time-off requests')));

  let filter = 'pending';
  const seg = el('div.seg', { style: { marginBottom: '18px' } });
  const counts = { pending: all.filter(r => r.status === 'pending').length, approved: all.filter(r => r.status === 'approved').length, denied: all.filter(r => r.status === 'denied').length, all: all.length };
  [['pending', 'Pending'], ['approved', 'Approved'], ['denied', 'Denied'], ['all', 'All']].forEach(([v, label]) => {
    const b = el('button' + (v === filter ? '.on' : ''), `${label} (${counts[v]})`);
    b.addEventListener('click', () => { filter = v; [...seg.children].forEach(x => x.classList.remove('on')); b.classList.add('on'); draw(); });
    seg.append(b);
  });
  screen.append(seg);

  const grid = el('div', { style: { display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))' } });
  screen.append(grid);

  function draw() {
    const rows = filter === 'all' ? all : all.filter(r => r.status === filter);
    grid.replaceChildren();
    if (!rows.length) { grid.append(el('div.card', emptyState('calplus', 'Nothing here', 'No ' + filter + ' requests.'))); return; }
    for (const r of rows) grid.append(card(r));
  }

  function card(r) {
    const p = r.ta_profiles || {};
    const bal = balIdx[r.employee_id + '_' + r.leave_type];
    const c = el('div.card');
    const head = el('div.row.between', { style: { marginBottom: '12px' } });
    const who = el('div.row', { style: { gap: '10px' } });
    who.append(avatar(p, 'sm'), el('div', el('div.b', p.full_name || 'Employee'), el('div.tiny.muted', p.department || '—')));
    head.append(who, pill(r.status));
    c.append(head);

    const meta = el('div', { style: { display: 'grid', gap: '8px', marginBottom: '12px' } });
    meta.append(
      metaRow('briefcase', `${TYPE_LABEL[r.leave_type]} Leave · ${r.days} day${r.days > 1 ? 's' : ''}`),
      metaRow('calendar', `${fmtShortDate(r.start_date)} → ${fmtShortDate(r.end_date)}`),
      metaRow('clock', `Requested ${ago(r.created_at)}`),
      bal ? metaRow('activity', `Balance: ${bal.remaining_days}/${bal.total_days} ${r.leave_type} left`) : null,
    );
    c.append(meta);
    if (r.reason) c.append(el('p.small.muted', { style: { marginBottom: '14px', background: 'var(--surface-2)', padding: '10px 12px', borderRadius: 'var(--r-sm)' } }, '“' + r.reason + '”'));

    if (r.status === 'pending') {
      const insufficient = bal && r.days > bal.remaining_days;
      const bar = el('div.row', { style: { gap: '10px' } });
      const deny = el('button.btn.btn--danger.grow.btn--sm', 'Deny');
      const appr = el('button.btn.btn--primary.grow.btn--sm', 'Approve');
      if (insufficient) { appr.disabled = true; c.append(el('div.err-text', { style: { marginBottom: '8px' } }, `Insufficient balance — needs ${r.days}, has ${bal.remaining_days}`)); }
      deny.addEventListener('click', () => decide(r, 'denied'));
      appr.addEventListener('click', () => decide(r, 'approved'));
      bar.append(deny, appr);
      c.append(bar);
    } else {
      c.append(el('div.tiny.muted', r.reviewed_at ? `${r.status === 'approved' ? 'Approved' : 'Denied'} ${ago(r.reviewed_at)}` : ''));
    }
    return c;
  }

  function decide(r, decision) {
    const p = r.ta_profiles || {};
    confirmDialog({
      title: decision === 'approved' ? 'Approve leave?' : 'Deny leave?',
      message: decision === 'approved'
        ? `Approve ${p.full_name}'s ${r.days}-day ${r.leave_type} leave? ${r.days} day(s) will be deducted from their balance and they'll be notified.`
        : `Deny ${p.full_name}'s ${r.leave_type} leave? Their balance stays unchanged and they'll be notified.`,
      confirmLabel: decision === 'approved' ? 'Approve' : 'Deny',
      danger: decision === 'denied',
      onConfirm: async () => {
        try {
          await Leaves.review(r.id, decision);
          toastOk(decision === 'approved' ? 'Leave approved & balance updated' : 'Leave denied');
          refresh();
        } catch (e) { toastErr(e.message); }
      },
    });
  }

  draw();
  return screen;
}

function metaRow(ic, text) {
  const r = el('div.row', { style: { gap: '8px', color: 'var(--ink-2)' } });
  r.innerHTML = icon(ic) + `<span class="small">${text}</span>`;
  r.firstChild.style.color = 'var(--muted)';
  r.firstChild.setAttribute('width', '18'); r.firstChild.setAttribute('height', '18');
  return r;
}
