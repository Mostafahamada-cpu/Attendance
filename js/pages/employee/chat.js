import { el, icon, pageHead, emptyState } from '../../lib/ui.js?v=20260813d';

export default async function chatPage({ navigate }) {
  const screen = el('div.screen.fade-up');
  screen.append(pageHead('Chat', () => navigate('#/home')));
  const card = el('div.card', { style: { paddingTop: '30px', paddingBottom: '30px' } });
  card.append(emptyState('chat', 'Messaging is coming soon',
    'Team chat will let you message colleagues and managers right here. It\'s on the roadmap for a future release.'));
  const badge = el('div.pill.pill--present', { style: { margin: '10px auto 0', width: 'fit-content' } }, 'Planned');
  card.append(badge);
  screen.append(card);
  return screen;
}
