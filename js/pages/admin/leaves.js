import { Leaves, Balances, Settings, Profiles, leaveStage, STAGE_LABEL } from '../../lib/data.js?v=20260903a';
import { el, icon, emptyState } from '../../lib/ui.js?v=20260903a';
import { toastOk, toastErr } from '../../lib/toast.js?v=20260903a';
import { leaveReviewCard, approverGapBanner } from '../shared/leave-review.js?v=20260903a';

// Admin view of the leave workflow. Uses the same review card as the manager
// Approvals screen, so both roles see identical facts and the same trail.
export default async function adminLeaves({ profile, refresh }) {
  const [all, balances, cfg, people] = await Promise.all([
    Leaves.all(),
    Balances.all(),
    Settings.get().catch(() => null),
    Profiles.all().catch(() => []),
  ]);
  const balIdx = {};
  for (const b of balances) balIdx[b.employee_id + '_' + b.leave_type] = b;
  const managers = people.filter(p => p.is_manager);

  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Leave Requests'),
    el('p.muted.small', 'Review time-off requests. Balances are deducted only after every required approval is in.')));

  const gap = approverGapBanner(cfg, managers.length, { isAdmin: true });
  if (gap) screen.append(gap);

  // ── Approval-flow control ─────────────────────────────────────────────────
  if (cfg) screen.append(flowCard(cfg, managers, refresh));

  // ── Buckets ───────────────────────────────────────────────────────────────
  const actionable = all.filter(r => r.status === 'pending'
    && r.employee_id !== profile?.id
    && r.requires_admin !== false && !r.admin_decision);
  const inProgress = all.filter(r => r.status === 'pending' && !actionable.includes(r));

  const counts = {
    todo: actionable.length,
    progress: inProgress.length,
    approved: all.filter(r => r.status === 'approved').length,
    denied: all.filter(r => r.status === 'denied').length,
    all: all.length,
  };

  const kpis = el('div.kpi-grid', { style: { margin: '22px 0' } });
  kpis.append(
    kpi('clock', 'warn', counts.todo, 'Awaiting your approval'),
    kpi('activity', 'blue', counts.progress, 'With the other approver'),
    kpi('checkcircle', 'teal', counts.approved, 'Approved'),
    kpi('xcircle', 'danger', counts.denied, 'Rejected'),
  );
  screen.append(kpis);

  let filter = 'todo';
  const seg = el('div.seg', { style: { marginBottom: '18px', display: 'flex', flexWrap: 'wrap' } });
  [['todo', 'Awaiting you'], ['progress', 'In progress'], ['approved', 'Approved'], ['denied', 'Rejected'], ['all', 'All']]
    .forEach(([v, label]) => {
      const b = el('button' + (v === filter ? '.on' : ''), { type: 'button' }, `${label} (${counts[v]})`);
      b.addEventListener('click', () => {
        filter = v;
        [...seg.children].forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        draw();
      });
      seg.append(b);
    });
  screen.append(seg);

  const grid = el('div', { style: { display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))' } });
  screen.append(grid);

  function rowsFor() {
    if (filter === 'todo') return actionable;
    if (filter === 'progress') return inProgress;
    if (filter === 'all') return all;
    return all.filter(r => r.status === filter);
  }

  function draw() {
    const rows = rowsFor();
    grid.replaceChildren();
    if (!rows.length) {
      grid.append(el('div.card', emptyState(
        filter === 'todo' ? 'check' : 'calplus',
        filter === 'todo' ? 'Nothing waiting on you' : 'Nothing here',
        filter === 'todo'
          ? 'Requests needing your approval will appear here.'
          : 'No requests in this state.')));
      return;
    }
    for (const r of rows) grid.append(leaveReviewCard(r, { profile, balIdx, onDone: refresh }));
  }
  draw();

  return screen;
}

// Who must approve. Kept beside the queue because turning manager approval off
// is the fix for the "no managers assigned" dead end.
function flowCard(cfg, managers, refresh) {
  const card = el('div.card');
  card.append(el('div.card-title', 'Approval flow'));
  card.append(el('p.small.muted', { style: { margin: '6px 0 14px' } },
    'Every request needs a decision from each required approver, in either order. One rejection rejects the request.'));

  let reqMgr = cfg.require_manager_approval !== false;
  let reqAdm = cfg.require_admin_approval !== false;

  const rows = el('div', { style: { display: 'grid', gap: '10px' } });
  const mgrRow = flowRow('Manager approval',
    managers.length
      ? `${managers.length} manager${managers.length > 1 ? 's' : ''}: ${managers.map(m => m.full_name).join(', ')}`
      : 'Nobody has manager rights yet',
    reqMgr, (v) => { reqMgr = v; markDirty(); });
  const admRow = flowRow('Admin approval', 'Every user with the admin role', reqAdm, (v) => { reqAdm = v; markDirty(); });
  rows.append(mgrRow.node, admRow.node);
  card.append(rows);

  const save = el('button.btn.btn--primary.btn--sm', { style: { marginTop: '14px' } }, 'Save approval flow');
  const dirty = el('span.tiny.muted', { style: { marginLeft: '10px' } }, '');
  const bar = el('div.row', { style: { marginTop: '4px' } });
  bar.append(save, dirty);
  card.append(bar);

  function markDirty() {
    const changed = reqMgr !== (cfg.require_manager_approval !== false)
      || reqAdm !== (cfg.require_admin_approval !== false);
    dirty.textContent = changed ? 'Unsaved changes' : '';
    dirty.style.color = 'var(--warn)';
  }

  save.addEventListener('click', async () => {
    if (!reqMgr && !reqAdm) return toastErr('At least one approver must be required.');
    save.disabled = true; save.textContent = 'Saving…';
    try {
      await Settings.setApprovalFlow({ requireManager: reqMgr, requireAdmin: reqAdm });
      toastOk('Approval flow updated');
      refresh();
    } catch (e) {
      toastErr(e.message);
      save.disabled = false; save.textContent = 'Save approval flow';
    }
  });
  return card;
}

function flowRow(title, sub, on, onChange) {
  const node = el('div.row.between', {
    style: { padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 'var(--r)', gap: '12px' },
  });
  node.append(el('div.grow', el('div.small.b', title), el('div.tiny.muted', sub)));
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
  node.append(sw);
  return { node };
}

function kpi(ic, tone, value, label) {
  const c = el('div.kpi');
  c.append(el('div.ic.ic--' + tone, { html: icon(ic) }));
  c.append(el('div', el('div.v', String(value)), el('div.k', label)));
  return c;
}
