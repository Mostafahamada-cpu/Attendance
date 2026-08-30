import { Balances } from '../../lib/data.js?v=20260830b';
import { el, avatar } from '../../lib/ui.js?v=20260830b';
import { LEAVE_TYPES } from './balances.js?v=20260830b';
import { securityCard } from '../shared/security.js?v=20260830b';

// Admin → My Account.
// The admin shell has no bottom nav, so administrators previously had no route
// to More → Change Password and no way to change their own password in-app.
// This is that route. It changes the SIGNED-IN user's own password through the
// GoTrue /user endpoint — an admin still cannot set anybody else's password
// from the app, which is deliberate.
export default async function adminAccount({ profile }) {
  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'My Account'),
    el('p.muted.small', 'Your profile, your vacation balance, and your password')));

  // ── Profile ────────────────────────────────────────────────────────────────
  const pcard = el('div.card.row', { style: { gap: '16px', marginBottom: '18px' } });
  pcard.append(avatar(profile, 'lg'));
  const info = el('div.grow');
  info.append(
    el('div', { style: { fontSize: '18px', fontWeight: '800' } }, profile.full_name || 'Administrator'),
    el('div.small.muted', profile.email || ''),
    el('div.row.wrap', { style: { gap: '7px', marginTop: '8px' } },
      el('span.pill.pill--working', 'Administrator'),
      el('span.pill.pill--present', `${profile.position || 'Admin'} · ${profile.department || 'Management'}`)));
  pcard.append(info);
  screen.append(pcard);

  // ── Own vacation balance (read-only, like every other employee's view) ─────
  //  An admin can edit anybody's allowance from Vacation Balances — including
  //  their own — but this card is a plain read-out, so the number shown here is
  //  always whatever the database actually holds.
  const bal = await Balances.mine().catch(() => []);
  if (bal.length) {
    const byType = Object.fromEntries(bal.map(b => [b.leave_type, b]));
    const card = el('div.card', { style: { marginBottom: '18px' } });
    card.append(el('div.card-sub.b', { style: { marginBottom: '10px' } }, 'My vacation balance'));
    const grid = el('div.row.wrap', { style: { gap: '8px' } });
    for (const [key, label] of LEAVE_TYPES) {
      const b = byType[key];
      grid.append(el('span.pill.pill--present', { style: { height: '26px' } },
        `${label} ${b ? `${b.remaining_days}/${b.total_days}` : '—'}`));
    }
    card.append(grid);
    card.append(el('p.tiny.muted', { style: { marginTop: '10px' } },
      'Set from Vacation Balances. Used days come from approved leave.'));
    screen.append(card);
  }

  // ── Security ───────────────────────────────────────────────────────────────
  //  The very same component the employee settings screen uses.
  screen.append(securityCard());

  return screen;
}

