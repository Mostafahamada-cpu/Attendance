import { auth } from '../../lib/supabase.js?v=20260903a';
import { el, icon } from '../../lib/ui.js?v=20260903a';
import { toastOk, toastErr } from '../../lib/toast.js?v=20260903a';

// Supabase's own floor. GoTrue enforces it server-side too; checking here just
// saves a round trip and gives a better message.
export const MIN_PASSWORD = 6;

// ─────────────────────────────────────────────────────────────────────────────
//  Security → Change Password
//
//  One component, used by BOTH settings screens — employee (More) and admin
//  (My Account) — so every authenticated user gets exactly the same form and
//  the same rules. It always acts on the CURRENT session's own account:
//  auth.changePassword() reads the email from the session and takes no "whose
//  account" argument, so there is no way to aim this at somebody else.
//
//  Nothing here writes a password to any table. Supabase Auth holds the hash;
//  the fields are type="password", they are cleared on success, and neither
//  password is logged, echoed into the DOM, or put in a URL.
// ─────────────────────────────────────────────────────────────────────────────
export function securityCard() {
  const card = el('div.card');
  card.append(el('div.card-sub.b', { style: { marginBottom: '4px' } }, 'Security'));
  card.append(el('p.tiny.muted', { style: { marginBottom: '14px' } },
    'Change the password you sign in with. You will stay signed in on this device.'));

  const current = field('Current Password', 'current-password');
  const next = field('New Password', 'new-password', `At least ${MIN_PASSWORD} characters`);
  const confirm = field('Confirm New Password', 'new-password');

  const form = el('form', { style: { display: 'grid', gap: '12px' } });
  form.append(current.wrap, next.wrap, confirm.wrap);

  const btn = el('button.btn.btn--primary', { type: 'submit', style: { marginTop: '4px' } }, 'Change Password');
  form.append(btn);
  card.append(form);

  const reset = () => { current.input.value = ''; next.input.value = ''; confirm.input.value = ''; };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cur = current.input.value;
    const nw = next.input.value;
    const cf = confirm.input.value;

    // Cheap checks first, each with its own message — "invalid password" alone
    // tells the user nothing about what to fix.
    if (!cur) return fail(current, 'Enter your current password');
    if (!nw) return fail(next, 'Enter a new password');
    if (nw.length < MIN_PASSWORD) return fail(next, `New password must be at least ${MIN_PASSWORD} characters`);
    if (nw === cur) return fail(next, 'The new password must be different from your current one');
    if (nw !== cf) return fail(confirm, 'New password and confirmation do not match');

    btn.disabled = true;
    btn.textContent = 'Changing…';
    try {
      // Verifies the current password, then updates via Supabase Auth.
      await auth.changePassword(cur, nw);
      reset();
      clearError(current); clearError(next); clearError(confirm);
      toastOk('Password changed — use it next time you sign in');
    } catch (err) {
      if (err.code === 'BAD_CURRENT') {
        current.input.value = '';
        fail(current, 'Your current password is incorrect');
      } else {
        // GoTrue's own wording for a rejected new password (too short, too
        // weak, same as the old one, rate-limited) is more specific than
        // anything we could invent, so pass it straight through.
        fail(next, err.message || 'Could not change your password');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Change Password';
    }
  });

  return card;
}

function fail(f, message) {
  showError(f, message);
  toastErr(message);
  f.input.focus();
}

function field(label, autocomplete, hint) {
  const wrap = el('div');
  wrap.append(el('label.tiny.muted.b', { style: { display: 'block', marginBottom: '5px' } }, label));
  const box = el('div.input-icon');
  box.innerHTML = `<span class="i-lead">${icon('lock')}</span>`;
  const input = el('input.input', {
    type: 'password', autocomplete, placeholder: hint || label,
    // Keeps a browser/OS password manager from treating this as a login form.
    name: label.toLowerCase().replace(/\s+/g, '-'),
  });
  box.append(input);
  wrap.append(box);
  const err = el('div.tiny', { style: { color: 'var(--danger)', marginTop: '5px', display: 'none' } });
  wrap.append(err);
  const f = { wrap, input, err };
  input.addEventListener('input', () => clearError(f));
  return f;
}

function showError(f, message) {
  f.err.textContent = message;
  f.err.style.display = 'block';
  f.input.style.borderColor = 'var(--danger)';
}

function clearError(f) {
  f.err.style.display = 'none';
  f.input.style.borderColor = '';
}
