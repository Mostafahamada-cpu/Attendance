import { Leaves, Balances, Settings, Profiles, leaveStage } from '../../lib/data.js?v=20260830a';
import { el, icon, pageHead, emptyState } from '../../lib/ui.js?v=20260830a';
import { leaveReviewCard, approverGapBanner } from '../shared/leave-review.js?v=20260830a';

// Manager view. A manager is an ordinary employee with is_manager = true, so
// this lives in the employee shell rather than the admin one — they still
// clock in and take leave like everybody else. Same review card as the admin
// screen; ta_review_leave() decides which slot their decision fills.
export default async function approvalsPage({ profile, navigate, refresh }) {
  const [all, balances, cfg, people] = await Promise.all([
    Leaves.all(),
    Balances.all().catch(() => []),
    Settings.get().catch(() => null),
    Profiles.all().catch(() => []),
  ]);
  const balIdx = {};
  for (const b of balances) balIdx[b.employee_id + '_' + b.leave_type] = b;
  const managerCount = people.filter(p => p.is_manager).length;

  const screen = el('div.screen.fade-up');
  screen.append(pageHead('Approvals', () => navigate('#/more')));

  // Things this manager can still act on, own requests excluded.
  const actionable = all.filter(r => r.status === 'pending'
    && r.employee_id !== profile.id
    && r.requires_manager !== false && !r.manager_decision);
  const waitingOthers = all.filter(r => r.status === 'pending' && !actionable.includes(r));

  const gap = approverGapBanner(cfg, managerCount, { isAdmin: false });
  if (gap) screen.append(gap);

  const strip = el('div.stat-3', { style: { marginBottom: '18px' } });
  strip.append(
    miniStat('To review', actionable.length),
    miniStat('In progress', waitingOthers.length),
    miniStat('Decided', all.filter(r => r.status !== 'pending').length),
  );
  screen.append(strip);

  let filter = 'todo';
  const counts = {
    todo: actionable.length,
    progress: waitingOthers.length,
    approved: all.filter(r => r.status === 'approved').length,
    denied: all.filter(r => r.status === 'denied').length,
  };
  const seg = el('div.seg', { style: { marginBottom: '16px', display: 'flex', flexWrap: 'wrap' } });
  [['todo', 'To review'], ['progress', 'In progress'], ['approved', 'Approved'], ['denied', 'Rejected']]
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

  const list = el('div.list');
  screen.append(list);

  function rowsFor() {
    if (filter === 'todo') return actionable;
    if (filter === 'progress') return waitingOthers;
    return all.filter(r => r.status === filter);
  }

  function draw() {
    const rows = rowsFor();
    list.replaceChildren();
    if (!rows.length) {
      list.append(el('div.card', emptyState(
        filter === 'todo' ? 'check' : 'calplus',
        filter === 'todo' ? 'Nothing waiting on you' : 'Nothing here',
        filter === 'todo'
          ? 'Leave requests needing your approval will appear here.'
          : 'No requests in this state.')));
      return;
    }
    for (const r of rows) {
      list.append(leaveReviewCard(r, { profile, balIdx, onDone: refresh }));
    }
  }
  draw();

  return screen;
}

function miniStat(label, value) {
  const t = el('div.stat');
  t.innerHTML = `<div class="v">${value}</div><div class="k">${label}</div>`;
  return t;
}
