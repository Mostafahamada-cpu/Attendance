import { auth } from '../../lib/supabase.js';
import { Notifs } from '../../lib/data.js';
import { el, icon, avatar, pageHead } from '../../lib/ui.js';
import { toastOk, toastErr, modal, confirmDialog } from '../../lib/toast.js';

export default async function morePage({ profile, navigate }) {
  const unread = (await Notifs.unread().catch(() => [])).length;
  const screen = el('div.screen.fade-up');
  screen.append(pageHead('More', () => navigate('#/home')));

  // Profile header card
  const pcard = el('div.card.row', { style: { gap: '16px' } });
  pcard.append(avatar(profile, 'lg'));
  const info = el('div.grow');
  info.append(
    el('div', { style: { fontSize: '18px', fontWeight: '800' } }, profile.full_name),
    el('div.small.muted', profile.email || ''),
    el('div.pill.pill--present', { style: { marginTop: '8px' } }, `${profile.position || 'Employee'} · ${profile.department || 'General'}`),
  );
  pcard.append(info);
  screen.append(pcard);

  // Menu
  const menu1 = el('div.menu', { style: { marginTop: '16px' } });
  menu1.append(
    item('user', 'My Profile', () => showProfile(profile)),
    item('calplus', 'My Leaves', () => navigate('#/leaves')),
    item('calendar', 'My Attendance', () => navigate('#/attendance')),
    item('bell', 'Notifications', () => navigate('#/notifications'), unread ? String(unread) : null),
  );
  screen.append(menu1);

  const menu2 = el('div.menu', { style: { marginTop: '16px' } });
  menu2.append(
    toggleItem('bell', 'Notification Settings', 'notif_push'),
    toggleItem('reminder', 'Clock-in Reminder', 'reminder'),
    item('lock', 'Change Password', changePassword),
  );
  screen.append(menu2);

  const menu3 = el('div.menu', { style: { marginTop: '16px' } });
  menu3.append(
    item('shield', 'Privacy Policy', () => infoModal('Privacy Policy', PRIVACY)),
    item('file', 'Terms & Conditions', () => infoModal('Terms & Conditions', TERMS)),
    item('help', 'Help & Feedback', () => infoModal('Help & Feedback', HELP)),
  );
  screen.append(menu3);

  const menu4 = el('div.menu', { style: { marginTop: '16px' } });
  const logout = el('button.menu-item.danger');
  logout.innerHTML = icon('logout', 'ic') + '<span class="grow">Logout</span>';
  logout.addEventListener('click', () => confirmDialog({
    title: 'Log out?', message: 'You\'ll need to sign in again to clock in.', confirmLabel: 'Log Out', danger: true,
    onConfirm: async () => { await auth.signOut(); location.hash = ''; location.reload(); },
  }));
  menu4.append(logout);
  screen.append(menu4);

  screen.append(el('p.tiny.muted.center-text', { style: { marginTop: '20px' } }, 'RingRoad Attendance · v1.0'));
  return screen;
}

function item(ic, label, onClick, badge) {
  const b = el('button.menu-item');
  b.innerHTML = icon(ic, 'ic') + `<span class="grow">${label}</span>` + (badge ? `<span class="pill pill--denied" style="height:22px">${badge}</span>` : '') + icon('chevR', 'chev');
  b.addEventListener('click', onClick);
  return b;
}

function toggleItem(ic, label, key) {
  const b = el('div.menu-item');
  const on = localStorage.getItem('rr_att_' + key) !== '0';
  b.innerHTML = icon(ic, 'ic') + `<span class="grow">${label}</span>`;
  const sw = el('div', { style: {
    width: '46px', height: '27px', borderRadius: '99px', padding: '3px', transition: 'background .2s',
    background: on ? 'var(--teal)' : 'var(--line)', cursor: 'pointer', flex: 'none' } });
  const knob = el('div', { style: { width: '21px', height: '21px', borderRadius: '50%', background: '#fff', transition: 'transform .2s', transform: on ? 'translateX(19px)' : 'none', boxShadow: '0 1px 3px rgba(0,0,0,.2)' } });
  sw.append(knob);
  let state = on;
  sw.addEventListener('click', () => {
    state = !state;
    localStorage.setItem('rr_att_' + key, state ? '1' : '0');
    sw.style.background = state ? 'var(--teal)' : 'var(--line)';
    knob.style.transform = state ? 'translateX(19px)' : 'none';
  });
  b.append(sw);
  return b;
}

function showProfile(p) {
  const body = el('div');
  const rows = [['Name', p.full_name], ['Email', p.email], ['Role', p.role], ['Department', p.department], ['Position', p.position]];
  rows.forEach(([k, v]) => {
    const r = el('div.row.between', { style: { padding: '11px 0', borderBottom: '1px solid var(--line)' } });
    r.append(el('span.small.muted', k), el('span.b.small', v || '—'));
    body.append(r);
  });
  modal({ title: 'My Profile', body, actions: [{ label: 'Close', cls: 'btn--pill-line' }] });
}

function changePassword() {
  const p1 = el('input.input', { type: 'password', placeholder: 'New password (min 6)' });
  const p2 = el('input.input', { type: 'password', placeholder: 'Confirm new password', style: { marginTop: '10px' } });
  const body = el('div'); body.append(p1, p2);
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

function infoModal(title, text) {
  const body = el('div', { style: { maxHeight: '52vh', overflowY: 'auto' } });
  body.append(el('p.small.muted', { style: { whiteSpace: 'pre-line', lineHeight: '1.6' } }, text));
  modal({ title, body, actions: [{ label: 'Close', cls: 'btn--pill-line' }] });
}

const PRIVACY = `We collect only the data needed to run attendance and time-off: your name, email, clock-in/out times, leave requests and balances. Data is stored securely in your company's Supabase project and protected by row-level security so you can only see your own records. We never sell your data. Contact your administrator to request access or deletion.`;
const TERMS = `By using RingRoad Attendance you agree to record accurate clock-in and clock-out times, submit genuine leave requests, and keep your login credentials confidential. Misuse may be reviewed by management. The service is provided as-is for internal company use.`;
const HELP = `Need help? Reach out to your HR administrator or manager for account issues, leave questions, or corrections to your attendance record. For technical problems, contact your internal IT/support team.`;
