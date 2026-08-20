import { Notifs } from '../../lib/data.js?v=20260820a';
import { el, icon, pageHead, emptyState } from '../../lib/ui.js?v=20260820a';
import { ago } from '../../lib/time.js?v=20260820a';
import { toastOk } from '../../lib/toast.js?v=20260820a';

const STYLE = {
  leave_approved: ['checkcircle', 'var(--teal)', 'var(--teal-050)'],
  leave_denied: ['xcircle', 'var(--danger)', 'var(--danger-bg)'],
  leave_submitted: ['calplus', 'var(--info)', 'var(--info-bg)'],
  reminder: ['reminder', 'var(--warn)', 'var(--warn-bg)'],
  // v2 — weekend changes and rest days
  weekend_approved: ['swap', 'var(--teal)', 'var(--teal-050)'],
  weekend_rejected: ['xcircle', 'var(--danger)', 'var(--danger-bg)'],
  weekend_submitted: ['swap', 'var(--info)', 'var(--info-bg)'],
  rest_approved: ['checkcircle', 'var(--teal)', 'var(--teal-050)'],
  rest_denied: ['xcircle', 'var(--danger)', 'var(--danger-bg)'],
  rest_submitted: ['moon', 'var(--info)', 'var(--info-bg)'],
  info: ['info', 'var(--info)', 'var(--info-bg)'],
};

export default async function notificationsPage({ navigate, refresh }) {
  const items = await Notifs.mine();
  const screen = el('div.screen.fade-up');

  const markAll = el('button.link', 'Mark all read');
  markAll.addEventListener('click', async () => {
    await Notifs.markAllRead(); toastOk('All marked as read'); refresh();
  });
  screen.append(pageHead('Notifications', () => navigate('#/home'), items.some(i => !i.is_read) ? markAll : null));

  if (!items.length) {
    screen.append(el('div.card', emptyState('bell', 'No notifications', 'Approvals, denials and reminders will appear here.')));
    return screen;
  }

  const list = el('div.list');
  for (const n of items) {
    const [ic, color, bg] = STYLE[n.type] || STYLE.info;
    const item = el('div.notif' + (n.is_read ? '' : '.unread'));
    const iconBox = el('div.ic', { style: { background: bg, color }, html: icon(ic) });
    const body = el('div.grow');
    body.append(el('div.nt', n.title), n.message && el('div.nm', n.message), el('div.nd', ago(n.created_at)));
    item.append(iconBox, body);
    if (!n.is_read) {
      item.style.cursor = 'pointer';
      item.addEventListener('click', async () => { await Notifs.markRead(n.id); item.classList.remove('unread'); refresh(); });
    }
    list.append(item);
  }
  screen.append(list);
  return screen;
}
