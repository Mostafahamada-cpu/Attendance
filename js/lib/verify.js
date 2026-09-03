// Clock-out verification word.
//
// Clocking out is the one action in the app that cannot be undone by the
// employee, so it asks for a shared word first. This is a deliberate speed
// bump against a mis-tap, not a secret: the real gate on clocking out is still
// ta_clock_out() in the database, which re-checks the geofence and computes
// the minutes itself. Nothing here changes that logic — the RPC is called
// exactly as before, only later.
import { el } from './ui.js?v=20260903a';
import { modal } from './toast.js?v=20260903a';

export const VERIFY_WORD = 'RingRoad';

// Case-insensitive, and forgiving of the space a phone keyboard adds.
// 'RingRoad', 'ringroad', 'RINGROAD', 'RiNgRoAd', '  RingRoad  ' all pass;
// anything else — including an empty box — fails.
export function isVerifyWord(input) {
  return String(input ?? '').trim().toLowerCase() === VERIFY_WORD.toLowerCase();
}

// Asks for the word, then calls onVerified(). Never resolves to the caller —
// the flow continues inside the callback, the way confirmDialog() does.
export function verifyClockOut({ workedLabel, onVerified }) {
  const body = el('div');
  body.append(el('p.small.muted', { style: { lineHeight: '1.6', marginBottom: '14px' } },
    (workedLabel ? `You have worked ${workedLabel} so far. ` : '')
    + `To finish your day, type the verification word ${VERIFY_WORD} below.`));

  const field = el('div.field');
  const input = el('input.input', {
    type: 'text', placeholder: VERIFY_WORD, autocomplete: 'off',
    autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
    'aria-label': 'Verification word',
  });
  const err = el('p.err-text', { style: { display: 'none' } }, 'That word is not correct.');
  field.append(input, err);
  body.append(field);
  body.append(el('p.tiny.muted', { style: { marginTop: '10px' } },
    'Capital letters do not matter — ringroad, RINGROAD and RingRoad are all accepted.'));

  const showError = (msg) => {
    err.textContent = msg;
    err.style.display = 'block';
    input.classList.add('input--err');
    input.focus();
    input.select();
  };
  const clearError = () => {
    err.style.display = 'none';
    input.classList.remove('input--err');
  };
  input.addEventListener('input', clearError);

  const dlg = modal({
    title: 'Confirm clock out',
    body,
    actions: [
      { label: 'Cancel', cls: 'btn--pill-line' },
      {
        label: 'Clock Out', cls: 'btn--primary',
        // The dialog stays open on a wrong word: closing it would make the
        // mistake look like a cancelled clock-out.
        onClick: (close) => {
          const raw = input.value;
          if (!raw.trim()) return showError('Type the verification word to continue.');
          if (!isVerifyWord(raw)) return showError(`That word is not correct. Type ${VERIFY_WORD}.`);
          close();
          onVerified?.();
        },
      },
    ],
  });

  // Enter submits, so the phone keyboard's "go" key works.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const raw = input.value;
    if (!raw.trim()) return showError('Type the verification word to continue.');
    if (!isVerifyWord(raw)) return showError(`That word is not correct. Type ${VERIFY_WORD}.`);
    dlg.close();
    onVerified?.();
  });

  setTimeout(() => input.focus(), 60);
  return dlg;
}
