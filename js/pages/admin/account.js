import { auth } from '../../lib/supabase.js?v=20260830a';
import { Balances } from '../../lib/data.js?v=20260830a';
import { el, avatar } from '../../lib/ui.js?v=20260830a';
import { toastOk, toastErr, modal } from '../../lib/toast.js?v=20260830a';
import { LEAVE_TYPES } from './balances.js?v=20260830a';

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
  const sec = el('div.card');
  sec.append(el('div.card-sub.b', { style: { marginBottom: '12px' } }, 'Security'));
  const row = el('div.row.between', { style: { gap: '12px' } });
  row.append(el('div.grow',
    el('div.small.b', 'Password'),
    el('div.tiny.muted', 'Change the password you sign in with')));
  const btn = el('button.btn.btn--primary.btn--sm', { style: { flex: 'none' } }, 'Change Password');
  btn.addEventListener('click', changePassword);
  row.append(btn);
  sec.append(row);
  screen.append(sec);

  return screen;
}

function changePassword() {
  const p1 = el('input.input', { type: 'password', placeholder: 'New password (min 6)' });
  const p2 = el('input.input', { type: 'password', placeholder: 'Confirm new password', style: { marginTop: '10px' } });
  const body = el('div');
  body.append(el('p.small.muted', { style: { marginBottom: '12px' } },
    'You will stay signed in on this device. Use the new password next time you log in.'), p1, p2);
  modal({
    title: 'Change Password', body,
    actions: [
      { label: 'Cancel', cls: 'btn--pill-line' },
      { label: 'Update', cls: 'btn--primary', onClick: async (close) => {
        if (p1.value.length < 6) return toastErr('Password must be 6+ characters');
        if (p1.value !== p2.value) return toastErr('Passwords don\'t match');
        try { await auth.updatePassword(p1.value); close(); toastOk('Password updated'); }
        catch (e) { toastErr(e.message); }
      } },
    ],
  });
}
