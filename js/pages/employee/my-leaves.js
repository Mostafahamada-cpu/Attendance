import { Leaves, Balances, leaveStage, STAGE_LABEL, STAGE_PILL } from '../../lib/data.js?v=20260820b';
import { el, icon, pill, pageHead, emptyState } from '../../lib/ui.js?v=20260820b';
import { fmtShortDate, ago } from '../../lib/time.js?v=20260820b';
import { signedUrl } from '../../lib/storage.js?v=20260820b';

const TYPE_LABEL = { casual: 'Casual Leave', medical: 'Medical Leave', planned: 'Planned Leave' };
const TYPE_ICON = { casual: 'coffee', medical: 'shield', planned: 'calendar' };

export default async function myLeaves({ navigate }) {
  const [requests, balances] = await Promise.all([Leaves.mine(), Balances.mine()]);
  const total = balances.reduce((s, b) => s + b.total_days, 0);
  const used = balances.reduce((s, b) => s + b.used_days, 0);

  const screen = el('div.screen.fade-up');
  screen.append(pageHead('My Leaves', () => navigate('#/home')));

  // summary strip — Used/Remaining reflect APPROVED leave only. Pending days
  // are shown apart because they deliberately don't move the balance yet.
  const strip = el('div.stat-3', { style: { marginBottom: '10px' } });
  strip.append(miniStat('Total', total), miniStat('Used', used), miniStat('Remaining', total - used));
  screen.append(strip);

  const pendingDays = Leaves.pendingDays(requests);
  if (pendingDays > 0) {
    screen.append(el('p.tiny.muted.center-text', { style: { marginBottom: '16px' } },
      `${pendingDays} day${pendingDays > 1 ? 's' : ''} awaiting approval — not deducted until fully approved.`));
  } else {
    screen.append(el('div', { style: { height: '8px' } }));
  }

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
  const stage = leaveStage(r);
  const card = el('div.card.card--flat');
  const head = el('div.row.between', { style: { marginBottom: '10px', gap: '10px' } });
  const left = el('div.row', { style: { gap: '10px' } });
  const ic = el('div.notif-ic', { style: { width: '38px', height: '38px', borderRadius: '11px', display: 'grid', placeContent: 'center', background: 'var(--teal-050)', color: 'var(--teal)' }, html: icon(TYPE_ICON[r.leave_type]) });
  left.append(ic, el('div', el('div.b', TYPE_LABEL[r.leave_type] || r.leave_type), el('div.tiny.muted', `${r.days} day${r.days > 1 ? 's' : ''} · applied ${ago(r.created_at)}`)));
  head.append(left, el('span.pill.pill--' + (STAGE_PILL[stage] || 'plain'), STAGE_LABEL[stage] || stage));
  card.append(head);

  const range = el('div.row', { style: { gap: '8px', marginBottom: '10px' } });
  range.innerHTML = `${icon('calendar')}<span class="small">${fmtShortDate(r.start_date)} → ${fmtShortDate(r.end_date)}</span>`;
  card.append(range);
  if (r.reason) card.append(el('p.small.muted', { style: { marginBottom: '10px' } }, r.reason));

  if (r.attachment_path) {
    const row = el('div.attach-row', { style: { marginBottom: '10px' } });
    row.append(el('span.ai', { html: icon('file', 'ic-sm') }));
    const link = el('button.link.grow', { type: 'button', style: { textAlign: 'left' } }, r.attachment_name || 'Attachment');
    link.addEventListener('click', async () => {
      const url = await signedUrl(r.attachment_path);
      if (url) window.open(url, '_blank', 'noopener');
    });
    row.append(link);
    card.append(row);
  }

  // Where it is in the approval chain.
  card.append(miniTrail(r));

  if (stage === 'approved' && r.balance_after != null) {
    card.append(el('div.tiny.muted', { style: { marginTop: '8px' } },
      `${r.days} day${r.days > 1 ? 's' : ''} deducted · ${r.balance_after} ${r.leave_type} day(s) left`));
  } else if (stage !== 'denied') {
    card.append(el('div.tiny.muted', { style: { marginTop: '8px' } },
      'Your balance is unchanged until this is fully approved.'));
  }

  const note = r.admin_note || r.manager_note;
  if (note) card.append(el('p.tiny', { style: { marginTop: '6px', color: 'var(--ink-2)' } }, 'Note: ' + note));
  return card;
}

// Compact two-step chain for the employee's own view.
function miniTrail(r) {
  const wrap = el('div.mini-trail');
  const steps = [];
  if (r.requires_manager !== false) steps.push(['Manager', r.manager_decision]);
  if (r.requires_admin !== false) steps.push(['Admin', r.admin_decision]);
  if (!steps.length) return wrap;
  steps.forEach(([label, decision], i) => {
    if (i) wrap.append(el('span.mt-sep', { html: icon('arrowR', 'ic-sm') }));
    const state = decision === 'approved' ? 'ok' : decision === 'denied' ? 'no' : 'wait';
    const s = el('span.mt-step.mt-step--' + state);
    s.append(el('span.mt-i', { html: icon(state === 'ok' ? 'check' : state === 'no' ? 'x' : 'clock', 'ic-sm') }),
      el('span', label));
    wrap.append(s);
  });
  return wrap;
}
