import { Leaves, Balances } from '../../lib/data.js';
import { el, icon, pill, pageHead, emptyState } from '../../lib/ui.js';
import { fmtShortDate, ago } from '../../lib/time.js';

const TYPE_LABEL = { casual: 'Casual Leave', medical: 'Medical Leave', planned: 'Planned Leave' };
const TYPE_ICON = { casual: 'coffee', medical: 'shield', planned: 'calendar' };

export default async function myLeaves({ navigate }) {
  const [requests, balances] = await Promise.all([Leaves.mine(), Balances.mine()]);
  const total = balances.reduce((s, b) => s + b.total_days, 0);
  const used = balances.reduce((s, b) => s + b.used_days, 0);

  const screen = el('div.screen.fade-up');
  screen.append(pageHead('My Leaves', () => navigate('#/home')));

  // summary strip
  const strip = el('div.stat-3', { style: { marginBottom: '18px' } });
  strip.append(miniStat('Total', total), miniStat('Used', used), miniStat('Remaining', total - used));
  screen.append(strip);

  const applyBtn = el('button.btn.btn--primary.btn--block', { style: { marginBottom: '18px' } });
  applyBtn.innerHTML = icon('plus') + '<span>New Leave Request</span>';
  applyBtn.addEventListener('click', () => navigate('#/apply'));
  screen.append(applyBtn);

  if (!requests.length) {
    screen.append(el('div.card', emptyState('calplus', 'No leave requests yet', 'Your requests will show up here once you apply.')));
    return screen;
  }

  const list = el('div.list');
  for (const r of requests) list.append(leaveCard(r));
  screen.append(list);
  return screen;
}

function miniStat(label, value) {
  const t = el('div.stat');
  t.innerHTML = `<div class="v">${value}</div><div class="k">${label}</div>`;
  return t;
}

export function leaveCard(r) {
  const card = el('div.card.card--flat');
  const head = el('div.row.between', { style: { marginBottom: '10px' } });
  const left = el('div.row', { style: { gap: '10px' } });
  const ic = el('div.notif-ic', { style: { width: '38px', height: '38px', borderRadius: '11px', display: 'grid', placeContent: 'center', background: 'var(--teal-050)', color: 'var(--teal)' }, html: icon(TYPE_ICON[r.leave_type]) });
  left.append(ic, el('div', el('div.b', TYPE_LABEL[r.leave_type] || r.leave_type), el('div.tiny.muted', `${r.days} day${r.days > 1 ? 's' : ''} · applied ${ago(r.created_at)}`)));
  head.append(left, pill(r.status));
  card.append(head);

  const range = el('div.row', { style: { gap: '8px', marginBottom: r.reason ? '8px' : '0' } });
  range.innerHTML = `${icon('calendar')}<span class="small">${fmtShortDate(r.start_date)} → ${fmtShortDate(r.end_date)}</span>`;
  card.append(range);
  if (r.reason) card.append(el('p.small.muted', r.reason));
  return card;
}
