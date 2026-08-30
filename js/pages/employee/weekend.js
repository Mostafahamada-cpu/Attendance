import { OffDays, Weekend } from '../../lib/data.js?v=20260830b';
import { el, icon, pageHead, emptyState, pill } from '../../lib/ui.js?v=20260830b';
import { toastOk, toastErr, confirmDialog } from '../../lib/toast.js?v=20260830b';
import { DOW, DOW_FULL, ago, fmtShortDate } from '../../lib/time.js?v=20260830b';

// Employee view: change your weekend (weekly off-days).
//   • Change 1 — approved automatically, effective immediately.
//   • Change 2 — submitted as a request, needs admin approval.
//   • After both are used, no further changes are possible.
// The limit is enforced by ta_request_weekend_change(); this screen only
// mirrors it so the rules are visible before you tap.
export default async function weekendPage({ profile, navigate, refresh }) {
  const [off, requests] = await Promise.all([OffDays.mine(), Weekend.mine()]);
  const current = [...new Set(off.map(o => o.day_of_week))].sort((a, b) => a - b);
  const used = Weekend.usedFrom(requests);
  const remaining = Math.max(0, Weekend.MAX - used);
  const pendingReq = requests.find(r => r.status === 'pending');

  const screen = el('div.screen.fade-up');
  screen.append(pageHead('My Weekend', () => navigate('#/more')));

  // ── Allowance meter ───────────────────────────────────────────────────────
  const meter = el('div.card');
  meter.append(el('div.row.between', { style: { marginBottom: '12px' } },
    el('div',
      el('div.card-title', 'Weekend changes'),
      el('div.card-sub', `You may change your weekend ${Weekend.MAX} times in total`)),
    el('div', { style: { textAlign: 'right' } },
      el('div', { style: { fontSize: '26px', fontWeight: '800', lineHeight: '1' } }, String(remaining)),
      el('div.tiny.muted', 'remaining'))));

  const pips = el('div.pips');
  for (let i = 1; i <= Weekend.MAX; i++) {
    const req = requests.find(r => r.change_number === i && r.status !== 'rejected');
    const cls = !req ? 'free' : req.status === 'pending' ? 'pending' : 'used';
    const p = el('div.pip.pip--' + cls);
    p.append(el('span.pn', '#' + i), el('span.pl',
      !req ? 'Available' : req.status === 'pending' ? 'Awaiting approval' : 'Used'));
    pips.append(p);
  }
  meter.append(pips);
  meter.append(el('p.tiny.muted', { style: { marginTop: '12px' } },
    `Used ${used} of ${Weekend.MAX}. The first change is approved automatically; the second needs admin approval.`));
  screen.append(meter);

  // ── Current weekend ───────────────────────────────────────────────────────
  const cur = el('div.card', { style: { marginTop: '14px' } });
  cur.append(el('div.card-title', 'Your current weekend'));
  cur.append(el('div.day-strip', { style: { marginTop: '12px' } },
    ...[0, 1, 2, 3, 4, 5, 6].map(d => el('span.day-chip' + (current.includes(d) ? '.on' : ''), DOW[d]))));
  cur.append(el('p.tiny.muted', { style: { marginTop: '10px' } },
    current.length ? labelDays(current) : 'No weekly off-days set yet — ask your admin, or pick them below.'));
  screen.append(cur);

  // ── Request form ──────────────────────────────────────────────────────────
  const formCard = el('div.card', { style: { marginTop: '14px' } });
  screen.append(formCard);

  // A pending request already consumes its slot, so check it BEFORE the
  // "nothing left" case — otherwise a waiting employee is told they're out of
  // changes rather than that their request is still being reviewed.
  if (pendingReq) {
    formCard.append(emptyState('clock', 'Change awaiting approval',
      `Your request to move your weekend to ${labelDays(pendingReq.requested_days)} is with the admin. You'll be notified once it's decided. This is change ${pendingReq.change_number} of ${Weekend.MAX}.`));
  } else if (remaining === 0) {
    formCard.append(emptyState('lock', 'No changes left',
      `You have used both of your ${Weekend.MAX} weekend changes, so no further weekend changes can be requested. Contact your admin if something needs correcting.`));
  } else {
    const isFirst = used === 0;
    formCard.append(el('div.card-title', isFirst ? 'Change your weekend' : 'Request your second weekend change'));
    formCard.append(el('p.small.muted', { style: { margin: '6px 0 14px' } }, isFirst
      ? 'This is your first change — it takes effect immediately, no approval needed.'
      : 'This is your final change and it must be approved by an admin before it takes effect.'));

    const need = current.length || null;
    const selected = new Set(current);
    const chips = el('div.day-strip');
    const dayBtns = {};
    for (let d = 0; d < 7; d++) {
      const c = el('button.day-chip' + (selected.has(d) ? '.on' : ''), { type: 'button', 'aria-pressed': selected.has(d) ? 'true' : 'false' }, DOW[d]);
      c.addEventListener('click', () => {
        if (selected.has(d)) selected.delete(d); else selected.add(d);
        c.classList.toggle('on', selected.has(d));
        c.setAttribute('aria-pressed', selected.has(d) ? 'true' : 'false');
        sync();
      });
      dayBtns[d] = c; chips.append(c);
    }
    formCard.append(chips);

    const hint = el('div.small', { style: { margin: '10px 0 14px' } });
    formCard.append(hint);

    const reasonF = el('div.field');
    reasonF.append(el('label', 'Reason (optional)'));
    const reason = el('textarea.textarea', { placeholder: 'Why do you need a different weekend?', maxlength: '400', style: { minHeight: '84px' } });
    reasonF.append(reason);
    formCard.append(reasonF);

    const submit = el('button.btn.btn--primary.btn--block');
    submit.innerHTML = icon('swap') + `<span>${isFirst ? 'Change my weekend' : 'Submit for approval'}</span>`;
    formCard.append(submit);

    function picked() { return [...selected].sort((a, b) => a - b); }
    function problem() {
      const p = picked();
      if (!p.length) return 'Pick at least one day.';
      if (p.length > 3) return 'A weekend can be at most 3 days.';
      if (need && p.length !== need) return `Pick exactly ${need} day${need > 1 ? 's' : ''} — you can move your weekend, not lengthen it.`;
      if (p.join(',') === current.join(',')) return 'That is already your current weekend.';
      return null;
    }
    function sync() {
      const err = problem();
      hint.textContent = err || `New weekend: ${labelDays(picked())}`;
      hint.style.color = err ? 'var(--danger)' : 'var(--teal-700)';
      hint.style.fontWeight = '600';
      submit.disabled = !!err;
    }
    sync();

    submit.addEventListener('click', () => {
      const err = problem();
      if (err) return toastErr(err);
      const days = picked();
      confirmDialog({
        title: isFirst ? 'Change your weekend?' : 'Submit weekend change?',
        message: isFirst
          ? `Your weekend becomes ${labelDays(days)} right away. This uses change 1 of ${Weekend.MAX} — you'll have ${Weekend.MAX - 1} left, and the next one needs admin approval.`
          : `Your request to move your weekend to ${labelDays(days)} goes to the admin. This uses your final change of ${Weekend.MAX}.`,
        confirmLabel: isFirst ? 'Change it' : 'Submit',
        onConfirm: async () => {
          submit.disabled = true; submit.querySelector('span').textContent = 'Submitting…';
          try {
            const r = await Weekend.request(days, reason.value.trim() || null);
            toastOk(r.status === 'auto_approved'
              ? 'Weekend updated — now ' + labelDays(r.requested_days)
              : 'Submitted — waiting for admin approval');
            refresh();
          } catch (e) {
            toastErr(e.message);
            submit.disabled = false;
            submit.querySelector('span').textContent = isFirst ? 'Change my weekend' : 'Submit for approval';
          }
        },
      });
    });
  }

  // ── History ───────────────────────────────────────────────────────────────
  screen.append(el('div.section-h', el('h2', 'Change history')));
  if (!requests.length) {
    screen.append(el('div.card', emptyState('swap', 'No weekend changes yet', 'Your requests will be listed here.')));
  } else {
    const list = el('div.list');
    for (const r of [...requests].sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at))) {
      list.append(historyCard(r));
    }
    screen.append(list);
  }

  return screen;
}

export function historyCard(r) {
  const c = el('div.card.card--flat');
  const head = el('div.row.between', { style: { marginBottom: '10px' } });
  head.append(el('div.b.small', `Change #${r.change_number}`), statusPill(r.status));
  c.append(head);
  c.append(el('div.row', { style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
    el('span.pill.pill--plain', labelDays(r.original_days) || '—'),
    el('span.arr', { html: icon('arrowR', 'ic-sm') }),
    el('span.pill.pill--present', labelDays(r.requested_days))));
  const meta = el('div.tiny.muted', { style: { marginTop: '10px' } },
    `Requested ${ago(r.requested_at)}` +
    (r.reviewed_at ? ` · ${r.status === 'auto_approved' ? 'auto-approved' : r.status} ${ago(r.reviewed_at)}` : ''));
  c.append(meta);
  if (r.reason) c.append(el('p.tiny.muted', { style: { marginTop: '6px' } }, '“' + r.reason + '”'));
  if (r.admin_note) c.append(el('p.tiny', { style: { marginTop: '6px', color: 'var(--ink-2)' } }, 'Admin: ' + r.admin_note));
  return c;
}

export function statusPill(status) {
  const map = {
    auto_approved: ['approved', 'Auto-approved'],
    approved: ['approved', 'Approved'],
    pending: ['pending', 'Pending'],
    rejected: ['denied', 'Rejected'],
  };
  const [cls, label] = map[status] || ['plain', status];
  return el('span.pill.pill--' + cls, label);
}

export function labelDays(days) {
  if (!days || !days.length) return '';
  return [...days].sort((a, b) => a - b).map(d => DOW_FULL[d]).join(', ');
}
