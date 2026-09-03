// Employee → Leave Permissions.
//
// Permission to step out for part of a working day. This is NOT vacation:
// vacation is whole days, deducts a leave balance and lives on the Apply Leave
// screen. A permission covers hours inside one day and deducts nothing.
//
// The first few permissions of each calendar month (3 by default) are approved
// the moment they are submitted — the database decides that, by counting the
// employee's own approved rows for that month, so the counter resets on the
// 1st with nothing to reset. Anything beyond the allowance is created as
// Pending and waits for an admin.
import { Permissions, PERMISSION_LABEL, PERMISSION_PILL } from '../../lib/data.js?v=20260903a';
import { el, icon, ring, pageHead, emptyState } from '../../lib/ui.js?v=20260903a';
import { toastOk, toastErr, confirmDialog } from '../../lib/toast.js?v=20260903a';
import { todayYMD, fmtShortDate, MONTHS } from '../../lib/time.js?v=20260903a';
import { hm12, mins } from '../../lib/money.js?v=20260903a';

export default async function empPermissions({ profile, navigate, refresh }) {
  const [usage, history] = await Promise.all([
    Permissions.usage(),
    Permissions.mine(),
  ]);

  const screen = el('div.screen.fade-up');
  screen.append(pageHead('Leave Permissions', () => navigate('#/more')));

  // ── Counter ───────────────────────────────────────────────────────────────
  const used = usage.used, limit = usage.limit, remaining = usage.remaining;
  const counter = el('div.card');
  const row = el('div.row', { style: { gap: '18px' } });
  row.append(ring({
    value: remaining, max: limit || 1, size: 96, stroke: 10,
    color: remaining > 0 ? 'var(--teal)' : 'var(--warn)',
    label: `${used}/${limit}`, sub: 'used',
  }));
  const info = el('div.grow');
  info.append(el('div', { style: { fontSize: '17px', fontWeight: '800' } },
    remaining > 0 ? `${remaining} left this month` : 'Allowance used up'));
  info.append(el('p.small.muted', { style: { marginTop: '4px', lineHeight: '1.55' } },
    remaining > 0
      ? `Your next ${remaining === 1 ? 'permission is' : `${remaining} permissions are`} approved straight away — no admin needed.`
      : `You have used all ${limit} for ${MONTHS[new Date().getMonth()]}. Another request still goes through, but an admin has to approve it.`));
  if (usage.pending > 0) {
    info.append(el('div.pill.pill--pending', { style: { marginTop: '8px' } },
      `${usage.pending} waiting for an admin`));
  }
  row.append(info);
  counter.append(row);
  counter.append(el('p.tiny.muted', { style: { marginTop: '12px' } },
    `The counter is your approved permissions for this calendar month. It goes back to 0 / ${limit} on the 1st.`));
  screen.append(counter);

  // ── Request form ──────────────────────────────────────────────────────────
  screen.append(el('div.section-h', el('h2', 'Request a permission')));
  const form = el('div.card');

  const dateF = field('Date', el('input.input', { type: 'date', value: todayYMD(), min: todayYMD() }));
  const startF = field('Start time', el('input.input', { type: 'time', value: '14:00' }));
  const endF = field('End time', el('input.input', { type: 'time', value: '15:00' }));

  const two = el('div', { style: { display: 'grid', gap: '12px', gridTemplateColumns: '1fr 1fr' } });
  two.append(startF.row, endF.row);

  const durBox = el('div.leave-calc', { style: { marginTop: '12px' } });
  const reason = el('textarea.textarea', { rows: '3', placeholder: 'Why do you need to step out? (optional)' });
  const reasonF = field('Reason', reason);

  form.append(dateF.row, two, durBox, reasonF.row);

  const submit = el('button.btn.btn--primary.btn--block', { style: { marginTop: '14px' } });
  form.append(submit);
  screen.append(form);

  function duration() {
    const a = toMinutes(startF.input.value), b = toMinutes(endF.input.value);
    if (a == null || b == null) return null;
    return b - a;
  }

  function syncForm() {
    const d = duration();
    durBox.classList.toggle('leave-calc--bad', d != null && d <= 0);
    if (d == null) {
      durBox.textContent = 'Pick a start and an end time.';
    } else if (d <= 0) {
      durBox.textContent = 'The end time must be after the start time.';
    } else if (d < 5) {
      durBox.textContent = 'A permission must be at least 5 minutes.';
      durBox.classList.add('leave-calc--bad');
    } else {
      durBox.replaceChildren();
      durBox.append(el('div.b', `Duration · ${mins(d)}`));
      durBox.append(el('div.tiny.muted', { style: { marginTop: '3px' } },
        remaining > 0
          ? 'Inside your monthly allowance — this will be approved immediately.'
          : 'Beyond your monthly allowance — this will wait for admin approval.'));
    }
    submit.textContent = remaining > 0 ? 'Submit — approved instantly' : 'Submit for admin approval';
  }
  startF.input.addEventListener('change', syncForm);
  endF.input.addEventListener('change', syncForm);
  syncForm();

  submit.addEventListener('click', async () => {
    const d = duration();
    if (!dateF.input.value) return toastErr('Pick a date');
    if (d == null) return toastErr('Pick a start and an end time');
    if (d <= 0) return toastErr('The end time must be after the start time');
    if (d < 5) return toastErr('A permission must be at least 5 minutes');

    submit.disabled = true; submit.textContent = 'Submitting…';
    try {
      // The server decides the status. Whatever it answers is the truth.
      const rec = await Permissions.request({
        date: dateF.input.value,
        start: startF.input.value,
        end: endF.input.value,
        reason: reason.value.trim() || null,
      });
      const row2 = Array.isArray(rec) ? rec[0] : rec;
      if (row2?.status === 'approved') toastOk('Permission approved — enjoy your time out');
      else toastOk('Submitted — an admin will review it');
      refresh?.();
    } catch (e) {
      toastErr(e.message);
      submit.disabled = false;
      syncForm();
    }
  });

  // ── History ───────────────────────────────────────────────────────────────
  screen.append(el('div.section-h', el('h2', 'My permissions')));
  if (!history.length) {
    screen.append(el('div.card', emptyState('clock', 'No permissions yet',
      'Requests you make will appear here with their status.')));
  } else {
    const byMonth = {};
    for (const r of history) (byMonth[r.permission_date.slice(0, 7)] ||= []).push(r);

    for (const [key, list] of Object.entries(byMonth)) {
      const [y, m] = key.split('-');
      const usedIn = list.filter(r => r.status === 'approved').length;
      const lim = list[0]?.monthly_limit ?? limit;

      const head = el('div.row.between', { style: { margin: '16px 0 8px', gap: '10px' } });
      head.append(el('span.small.b', `${MONTHS[Number(m) - 1]} ${y}`),
        el('span.pill.pill--' + (usedIn >= lim ? 'pending' : 'approved'), { style: { height: '22px' } },
          `Used ${usedIn} / ${lim}`));
      screen.append(head);

      const list2 = el('div.list');
      list.forEach((r, i) => list2.append(permRow(r, i + 1, refresh)));
      screen.append(list2);
    }
  }

  return screen;
}

function permRow(r, n, refresh) {
  const row = el('div.lrow');
  row.append(el('div.rest-ic', { html: icon('clock') }));
  row.append(el('div.grow',
    el('div.name', `${n}. ${fmtShortDate(r.permission_date)} · ${mins(r.duration_minutes)}`),
    el('div.meta', `${hm12(r.start_time)} – ${hm12(r.end_time)}`
      + (r.reason ? ` · ${r.reason}` : '')
      + (r.admin_note ? ` · Admin: ${r.admin_note}` : ''))));

  const right = el('div', { style: { textAlign: 'right', flex: 'none' } });
  right.append(el('span.pill.pill--' + (PERMISSION_PILL[r.status] || 'plain'),
    r.status === 'approved' && r.approval_type === 'automatic' ? 'Approved'
      : PERMISSION_LABEL[r.status] || r.status));
  if (r.status === 'approved' && r.approval_type === 'automatic') {
    right.append(el('div.tiny.muted', { style: { marginTop: '3px' } }, 'automatic'));
  } else if (r.status === 'approved') {
    right.append(el('div.tiny.muted', { style: { marginTop: '3px' } }, 'by an admin'));
  }
  row.append(right);

  // You may withdraw your own request while the day is still ahead. Cancelling
  // hands the allowance back — the counter only ever counts approved rows.
  const canCancel = ['pending', 'approved'].includes(r.status) && r.permission_date >= todayYMD();
  if (canCancel) {
    const x = el('button', { 'aria-label': 'Cancel this permission', style: { color: 'var(--ink-3)', flex: 'none' }, html: icon('x', 'ic-sm') });
    x.addEventListener('click', () => confirmDialog({
      title: 'Cancel this permission?',
      message: `${fmtShortDate(r.permission_date)}, ${hm12(r.start_time)} – ${hm12(r.end_time)}.`
        + (r.status === 'approved' ? ' It goes back into your monthly allowance.' : ''),
      confirmLabel: 'Cancel it', danger: true,
      onConfirm: async () => {
        try { await Permissions.cancel(r.id); toastOk('Permission cancelled'); refresh?.(); }
        catch (e) { toastErr(e.message); }
      },
    }));
    row.append(x);
  }
  return row;
}

function toMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function field(label, input) {
  const row = el('div.field');
  row.append(el('label.tiny.b', { style: { display: 'block', marginBottom: '5px' } }, label));
  row.append(input);
  return { row, input };
}
