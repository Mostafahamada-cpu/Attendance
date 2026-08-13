import { auth } from '../lib/supabase.js?v=20260813d';
import { el, icon } from '../lib/ui.js?v=20260813d';
import { toast, toastErr, toastOk, modal } from '../lib/toast.js?v=20260813d';

export default function loginPage({ onAuthed }) {
  const wrap = el('div.auth.fade-up');
  const card = el('div.auth-card');
  card.innerHTML = `<div class="auth-logo">${icon('clock')}</div>
    <h1>Welcome back</h1>
    <p class="sub">Sign in to clock in and manage your time off</p>`;

  const form = el('form');
  const emailF = field('Email', 'mail', 'email', 'you@ringroad.re');
  const passWrap = passwordField();
  form.append(emailF.node, passWrap.node);

  const forgot = el('button.link', { type: 'button', style: { display: 'block', marginLeft: 'auto', marginBottom: '18px' } }, 'Forgot password?');
  forgot.addEventListener('click', () => forgotFlow(emailF.input.value));
  form.append(forgot);

  const submit = el('button.btn.btn--primary.btn--block', { type: 'submit' }, 'Log In');
  form.append(submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailF.input.value.trim(), pass = passWrap.input.value;
    if (!email || !pass) { toastErr('Enter your email and password'); return; }
    submit.disabled = true; submit.textContent = 'Signing in…';
    try {
      await auth.signIn(email, pass);
      toastOk('Signed in');
      onAuthed();
    } catch (err) {
      toastErr(friendly(err.message));
      submit.disabled = false; submit.textContent = 'Log In';
    }
  });

  card.append(form);

  // Google OAuth (optional — only meaningful if configured in Supabase)
  const divider = el('div.divider', 'or');
  const google = el('button.btn.btn--block.btn--pill-line', { type: 'button' });
  google.innerHTML = icon('google') + '<span>Continue with Google</span>';
  google.addEventListener('click', () => {
    const url = new URL(location.href);
    const redirect = url.origin + url.pathname;
    import('../../config.js?v=20260813d').then(({ SUPABASE_URL }) => {
      location.href = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirect)}`;
    });
  });
  card.append(divider, google);

  const alt = el('p.alt');
  const signupLink = el('button.link', { type: 'button' }, 'Create one');
  signupLink.addEventListener('click', () => signupFlow(onAuthed, emailF.input.value));
  alt.append(document.createTextNode('New here? '), signupLink);
  card.append(alt);

  wrap.append(card);
  return wrap;
}

function field(label, iconName, type, placeholder) {
  const node = el('div.field');
  node.append(el('label', label));
  const box = el('div.input-icon');
  box.innerHTML = `<span class="i-lead">${icon(iconName)}</span>`;
  const input = el('input.input', { type, placeholder, autocomplete: type === 'email' ? 'email' : '' });
  box.append(input);
  node.append(box);
  return { node, input };
}

function passwordField(label = 'Password') {
  const node = el('div.field');
  node.append(el('label', label));
  const box = el('div.input-icon');
  box.innerHTML = `<span class="i-lead">${icon('lock')}</span>`;
  const input = el('input.input', { type: 'password', placeholder: '••••••••', autocomplete: 'current-password' });
  const toggle = el('button.i-trail', { type: 'button', 'aria-label': 'Show password', html: icon('eye') });
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.innerHTML = icon(show ? 'eyeoff' : 'eye');
  });
  box.append(input, toggle);
  node.append(box);
  return { node, input };
}

function forgotFlow(prefill) {
  const inp = el('input.input', { type: 'email', placeholder: 'you@ringroad.re', value: prefill || '' });
  const body = el('div');
  body.append(el('p.small.muted', { style: { marginBottom: '14px' } }, 'Enter your email and we\'ll send a reset link.'), inp);
  modal({
    title: 'Reset password', body,
    actions: [
      { label: 'Cancel', cls: 'btn--pill-line' },
      { label: 'Send link', cls: 'btn--primary', onClick: async (close) => {
        if (!inp.value.trim()) { toastErr('Enter your email'); return; }
        try { await auth.recover(inp.value.trim()); close(); toastOk('Reset link sent — check your inbox'); }
        catch (e) { toastErr(e.message); }
      } },
    ],
  });
}

function signupFlow(onAuthed, prefillEmail) {
  const name = el('input.input', { placeholder: 'Full name' });
  const email = el('input.input', { type: 'email', placeholder: 'you@ringroad.re', value: prefillEmail || '' });
  const pass = el('input.input', { type: 'password', placeholder: 'Password (min 6 chars)' });
  const body = el('div');
  [name, email, pass].forEach(i => { i.style.marginBottom = '12px'; body.append(i); });
  body.append(el('p.tiny.muted', 'Accounts are created as employees. Ask an admin to promote you if needed.'));
  modal({
    title: 'Create account', body,
    actions: [
      { label: 'Cancel', cls: 'btn--pill-line' },
      { label: 'Sign up', cls: 'btn--primary', onClick: async (close) => {
        if (!name.value.trim() || !email.value.trim() || pass.value.length < 6) { toastErr('Fill all fields (password 6+ chars)'); return; }
        try {
          const d = await auth.signUp(email.value.trim(), pass.value, { full_name: name.value.trim() });
          close();
          if (d.access_token) { toastOk('Account created'); onAuthed(); }
          else toastOk('Account created — check your email to confirm, then log in.');
        } catch (e) { toastErr(e.message); }
      } },
    ],
  });
}

function friendly(msg) {
  if (/invalid login/i.test(msg)) return 'Wrong email or password';
  if (/email not confirmed/i.test(msg)) return 'Please confirm your email first';
  return msg || 'Sign in failed';
}
