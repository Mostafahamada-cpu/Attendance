import { Leaves, Balances } from '../../lib/data.js?v=20260830a';
import { el, icon, pageHead } from '../../lib/ui.js?v=20260830a';
import { toastOk, toastErr } from '../../lib/toast.js?v=20260830a';
import { todayYMD, daysBetween, fmtShortDate } from '../../lib/time.js?v=20260830a';
import { uploadLeaveAttachment, attachmentsAvailable, validateFile, ACCEPT, MAX_BYTES } from '../../lib/storage.js?v=20260830a';

const TYPES = [
  { v: 'casual', label: 'Casual', ic: 'coffee' },
  { v: 'medical', label: 'Medical', ic: 'shield' },
  { v: 'planned', label: 'Planned', ic: 'calendar' },
];

// Apply for leave: type → from → to → live day count → optional reason and
// attachment → submit. Submitting creates a PENDING request and deducts
// nothing; the balance moves only when every required approver has approved.
export default async function applyLeave({ profile, navigate, refresh }) {
  const [balances, myRequests, canAttach] = await Promise.all([
    Balances.mine(),
    Leaves.mine().catch(() => []),
    attachmentsAvailable().catch(() => false),
  ]);
  const balByType = Object.fromEntries(balances.map(b => [b.leave_type, b]));

  const screen = el('div.screen.fade-up');
  screen.append(pageHead('Apply for Leave', () => navigate('#/home')));

  const card = el('div.card');
  const form = el('form');
  let selType = 'casual';
  let attachment = null;          // { path, name } once uploaded

  // ── 1. Leave type ─────────────────────────────────────────────────────────
  form.append(fieldLabel('Leave Type'));
  const chips = el('div.seg', { style: { display: 'flex', width: '100%', marginBottom: '16px' } });
  const chipEls = {};
  TYPES.forEach(t => {
    const c = el('button.grow' + (t.v === selType ? '.on' : ''), { type: 'button', style: { flex: '1' } }, t.label);
    c.addEventListener('click', () => {
      selType = t.v;
      Object.values(chipEls).forEach(x => x.classList.remove('on'));
      c.classList.add('on');
      sync();
    });
    chipEls[t.v] = c; chips.append(c);
  });
  form.append(chips);

  // ── 2. Dates ──────────────────────────────────────────────────────────────
  const two = el('div.two');
  const fromI = el('input.input', { type: 'date', value: todayYMD(), min: todayYMD(), required: 'required' });
  const toI = el('input.input', { type: 'date', value: todayYMD(), min: todayYMD(), required: 'required' });
  two.append(labelled('From Date', fromI), labelled('To Date', toI));
  form.append(two);

  // ── 3. Live calculation ───────────────────────────────────────────────────
  const calc = el('div.leave-calc');
  form.append(calc);

  // ── 4. Reason ─────────────────────────────────────────────────────────────
  const reasonF = el('div.field', { style: { marginTop: '16px' } });
  reasonF.append(el('label', 'Reason (optional)'));
  const reason = el('textarea.textarea', { placeholder: 'Add a short reason for your leave…', maxlength: '500' });
  reasonF.append(reason);
  form.append(reasonF);

  // ── 5. Attachment ─────────────────────────────────────────────────────────
  const attachF = el('div.field');
  const attachLabel = el('label', 'Attachment (optional)');
  attachF.append(attachLabel);
  const attachHint = el('p.tiny.muted', { style: { margin: '-2px 0 8px' } });
  attachF.append(attachHint);

  const fileInput = el('input', { type: 'file', accept: ACCEPT, style: { display: 'none' } });
  const dropZone = el('button.attach-zone', { type: 'button' });
  const attachStatus = el('div.attach-status');
  attachF.append(dropZone, fileInput, attachStatus);
  if (canAttach) form.append(attachF);

  function renderAttach() {
    dropZone.replaceChildren();
    if (!attachment) {
      dropZone.append(el('span.az-ic', { html: icon('plus') }),
        el('span.az-t', 'Choose a file'),
        el('span.az-s', `PDF or image · up to ${MAX_BYTES / 1048576} MB`));
      dropZone.classList.remove('on');
      attachStatus.replaceChildren();
    } else {
      dropZone.append(el('span.az-ic', { html: icon('file') }),
        el('span.az-t', attachment.name),
        el('span.az-s', 'Attached — tap to replace'));
      dropZone.classList.add('on');
      const rm = el('button.link', { type: 'button' }, 'Remove attachment');
      rm.addEventListener('click', (e) => { e.stopPropagation(); attachment = null; fileInput.value = ''; renderAttach(); });
      attachStatus.replaceChildren(rm);
    }
  }
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const bad = validateFile(file);
    if (bad) { fileInput.value = ''; return toastErr(bad); }
    dropZone.disabled = true;
    attachStatus.replaceChildren(el('span.tiny.muted', 'Uploading…'));
    try {
      attachment = await uploadLeaveAttachment(file, profile.id);
      toastOk('File attached');
    } catch (e) { toastErr(e.message); fileInput.value = ''; }
    finally { dropZone.disabled = false; renderAttach(); }
  });
  renderAttach();

  // ── Submit ────────────────────────────────────────────────────────────────
  const submit = el('button.btn.btn--primary.btn--block', { type: 'submit', style: { marginTop: '4px' } });
  submit.innerHTML = icon('calplus') + '<span>Submit Leave Request</span>';
  form.append(submit);
  form.append(el('p.tiny.muted.center-text', { style: { marginTop: '10px', lineHeight: '1.5' } },
    'Your balance stays unchanged while the request is pending. Days are deducted only after it is fully approved.'));

  // ── Live state ────────────────────────────────────────────────────────────
  function computeDays() {
    const s = fromI.value, e = toI.value;
    if (!s || !e || e < s) return 0;
    return daysBetween(s, e);
  }

  // Available = remaining − days already awaiting approval. Pending requests
  // don't touch the balance, but they can't be double-spent either.
  function availability() {
    const b = balByType[selType];
    const remaining = b?.remaining_days ?? 0;
    const pending = Leaves.pendingDays(myRequests, selType);
    return { total: b?.total_days ?? 0, used: b?.used_days ?? 0, remaining, pending, available: Math.max(0, remaining - pending) };
  }

  function problem() {
    const s = fromI.value, e = toI.value;
    if (!s || !e) return 'Pick both a start and an end date.';
    if (e < s) return 'To Date cannot be before From Date.';
    if (s < todayYMD()) return 'Leave cannot start in the past.';
    const days = computeDays();
    if (days <= 0) return 'That date range is not valid.';
    const a = availability();
    if (!balByType[selType]) return `You have no ${selType} leave allowance. Ask your admin to set one up.`;
    if (days > a.available) {
      return a.pending > 0
        ? `Not enough ${selType} leave — you requested ${days} day${days > 1 ? 's' : ''} but only ${a.available} are available (${a.pending} already awaiting approval).`
        : `Not enough ${selType} leave — you requested ${days} day${days > 1 ? 's' : ''} but only ${a.available} remain.`;
    }
    // Overlap mirror of the server check.
    const clash = myRequests.find(r => r.status !== 'denied' && !(e < r.start_date || s > r.end_date));
    if (clash) return `You already have a request covering ${fmtShortDate(clash.start_date)} → ${fmtShortDate(clash.end_date)}.`;
    return null;
  }

  function sync() {
    const days = computeDays();
    const a = availability();
    const err = problem();

    attachHint.textContent = selType === 'medical'
      ? 'Attach a medical certificate if your organisation requires one.'
      : 'You can attach a supporting document if you have one.';
    attachLabel.textContent = selType === 'medical' ? 'Medical certificate (optional)' : 'Attachment (optional)';

    calc.replaceChildren();
    calc.className = 'leave-calc' + (err ? ' leave-calc--bad' : '');

    const dayRow = el('div.row.between');
    dayRow.append(el('span.small.muted', 'Requested Days'),
      el('span.lc-days', days > 0 ? `${days} day${days > 1 ? 's' : ''}` : '—'));
    calc.append(dayRow);

    calc.append(divider());
    calc.append(calcRow(`${cap(selType)} balance`, `${a.remaining} of ${a.total} day${a.total === 1 ? '' : 's'}`));
    if (a.pending > 0) calc.append(calcRow('Awaiting approval', `${a.pending} day${a.pending > 1 ? 's' : ''}`, 'muted'));
    calc.append(calcRow('Available to request', `${a.available} day${a.available === 1 ? '' : 's'}`, 'b'));
    // Only project the outcome when the request is actually submittable —
    // showing "remaining after approval" next to an error reads as if it were
    // going ahead.
    if (!err && days > 0 && days <= a.available) {
      calc.append(calcRow('Remaining after approval', `${a.remaining - days} day${a.remaining - days === 1 ? '' : 's'}`, 'ok'));
    }

    if (err) calc.append(el('div.err-text', { style: { marginTop: '10px' } }, err));
    submit.disabled = !!err;
  }

  fromI.addEventListener('change', () => {
    if (toI.value < fromI.value) toI.value = fromI.value;
    toI.min = fromI.value;
    sync();
  });
  toI.addEventListener('change', sync);
  sync();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = problem();
    if (err) return toastErr(err);

    submit.disabled = true;
    submit.querySelector('span').textContent = 'Submitting…';
    try {
      await Leaves.request({
        type: selType,
        start: fromI.value,
        end: toI.value,
        reason: reason.value.trim() || null,
        attachmentPath: attachment?.path || null,
        attachmentName: attachment?.name || null,
      });
      toastOk('Leave request submitted — pending approval');
      navigate('#/leaves');
    } catch (err2) {
      toastErr(err2.message);
      submit.disabled = false;
      submit.querySelector('span').textContent = 'Submit Leave Request';
    }
  });

  card.append(form);
  screen.append(card);
  return screen;
}

// ---- pieces ---------------------------------------------------------------
function fieldLabel(text) {
  return el('label.small.b', { style: { display: 'block', marginBottom: '8px' } }, text);
}
function labelled(label, input) {
  const f = el('div.field');
  f.append(el('label', label), input);
  return f;
}
function calcRow(label, value, tone) {
  const r = el('div.row.between', { style: { padding: '5px 0' } });
  r.append(el('span.small' + (tone === 'muted' ? '.muted' : ''), label),
    el('span.small.b', { style: tone === 'ok' ? { color: 'var(--teal-700)' } : {} }, value));
  return r;
}
function divider() {
  return el('div', { style: { height: '1px', background: 'var(--line)', margin: '10px 0 6px' } });
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
