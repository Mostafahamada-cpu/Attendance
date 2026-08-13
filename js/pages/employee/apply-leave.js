import { Leaves, Balances } from '../../lib/data.js?v=20260813c';
import { el, icon, pageHead } from '../../lib/ui.js?v=20260813c';
import { toastOk, toastErr } from '../../lib/toast.js?v=20260813c';
import { todayYMD, daysBetween, fmtShortDate } from '../../lib/time.js?v=20260813c';

const TYPES = [
  { v: 'casual', label: 'Casual Leave', ic: 'coffee', color: 'var(--teal)' },
  { v: 'medical', label: 'Medical Leave', ic: 'shield', color: 'var(--danger)' },
  { v: 'planned', label: 'Planned Leave', ic: 'calendar', color: 'var(--info)' },
];

export default async function applyLeave({ navigate, refresh }) {
  const balances = await Balances.mine();
  const balByType = Object.fromEntries(balances.map(b => [b.leave_type, b]));

  const screen = el('div.screen.fade-up');
  screen.append(pageHead('Apply for Leave', () => navigate('#/home')));

  const card = el('div.card');
  const form = el('form');

  // Leave type selector (chips)
  form.append(el('label.small.b', { style: { display: 'block', marginBottom: '8px' } }, 'Leave Type'));
  const chips = el('div.seg', { style: { display: 'flex', width: '100%', marginBottom: '18px' } });
  let selType = 'casual';
  const chipEls = {};
  TYPES.forEach(t => {
    const c = el('button.grow' + (t.v === selType ? '.on' : ''), { type: 'button', style: { flex: '1' } }, t.label.replace(' Leave', ''));
    c.addEventListener('click', () => { selType = t.v; Object.values(chipEls).forEach(x => x.classList.remove('on')); c.classList.add('on'); updateBalHint(); });
    chipEls[t.v] = c; chips.append(c);
  });
  form.append(chips);

  const balHint = el('div.small.muted', { style: { marginBottom: '16px' } });
  function updateBalHint() {
    const b = balByType[selType];
    balHint.textContent = b ? `You have ${b.remaining_days} of ${b.total_days} ${selType} days remaining.` : '';
  }
  updateBalHint();
  form.append(balHint);

  // Date range
  const two = el('div.two');
  const startF = dateField('Start date', todayYMD());
  const endF = dateField('End date', todayYMD());
  two.append(startF.node, endF.node);
  form.append(two);

  const daysPill = el('div.pill.pill--present', { style: { margin: '2px 0 16px' } }, '1 day selected');
  form.append(daysPill);

  function computeDays() {
    const s = startF.input.value, e = endF.input.value;
    if (!s || !e || e < s) return 0;
    return daysBetween(s, e);
  }
  function refreshDays() {
    const d = computeDays();
    daysPill.textContent = d > 0 ? `${d} day${d > 1 ? 's' : ''} selected` : 'Invalid range';
    daysPill.className = 'pill ' + (d > 0 ? 'pill--present' : 'pill--denied');
  }
  startF.input.addEventListener('change', () => { if (endF.input.value < startF.input.value) endF.input.value = startF.input.value; refreshDays(); });
  endF.input.addEventListener('change', refreshDays);

  // Reason
  const reasonF = el('div.field');
  reasonF.append(el('label', 'Reason'));
  const reason = el('textarea.textarea', { placeholder: 'Add a short reason for your leave…', maxlength: '500' });
  reasonF.append(reason);
  form.append(reasonF);

  const submit = el('button.btn.btn--primary.btn--block', { type: 'submit' });
  submit.innerHTML = icon('calplus') + '<span>Submit Leave Request</span>';
  form.append(submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const days = computeDays();
    const s = startF.input.value, en = endF.input.value;
    const bal = balByType[selType];

    if (!s || !en) return toastErr('Pick a start and end date');
    if (en < s) return toastErr('End date must be after start date');
    if (s < todayYMD()) return toastErr('Start date can\'t be in the past');
    if (days <= 0) return toastErr('Invalid date range');
    if (!reason.value.trim()) return toastErr('Please add a reason');
    if (bal && days > bal.remaining_days) return toastErr(`Only ${bal.remaining_days} ${selType} days remaining`);

    submit.disabled = true; submit.querySelector('span').textContent = 'Submitting…';
    try {
      // guard against overlapping pending/approved request
      const existing = await Leaves.mine();
      const clash = existing.find(r => r.status !== 'denied' && !(en < r.start_date || s > r.end_date));
      if (clash) { toastErr('You already have a request overlapping these dates'); reset(); return; }

      await Leaves.create({ leave_type: selType, start_date: s, end_date: en, days, reason: reason.value.trim(), status: 'pending' });
      toastOk('Leave request submitted');
      navigate('#/leaves');
    } catch (err) { toastErr(err.message); reset(); }

    function reset() { submit.disabled = false; submit.querySelector('span').textContent = 'Submit Leave Request'; }
  });

  card.append(form);
  screen.append(card);
  return screen;
}

function dateField(label, val) {
  const node = el('div.field');
  node.append(el('label', label));
  const input = el('input.input', { type: 'date', value: val, min: val });
  node.append(input);
  return { node, input };
}

