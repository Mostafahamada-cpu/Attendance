// The leave-request review card, shared by the Admin "Leave Requests" screen
// and the Manager "Approvals" screen so both see exactly the same facts and
// the same approval trail. Which buttons appear depends on the viewer's role
// and on which decision slots are still open — ta_review_leave() re-checks all
// of it server-side.
import { Leaves, leaveStage, STAGE_LABEL, STAGE_PILL, canReview } from '../../lib/data.js?v=20260830b';
import { el, icon, avatar } from '../../lib/ui.js?v=20260830b';
import { toastOk, toastErr, modal } from '../../lib/toast.js?v=20260830b';
import { fmtShortDate, ago } from '../../lib/time.js?v=20260830b';
import { signedUrl } from '../../lib/storage.js?v=20260830b';

export const TYPE_LABEL = { casual: 'Casual', medical: 'Medical', planned: 'Planned' };
export const TYPE_ICON = { casual: 'coffee', medical: 'shield', planned: 'calendar' };

export function stagePill(r) {
  const stage = leaveStage(r);
  return el('span.pill.pill--' + (STAGE_PILL[stage] || 'plain'), STAGE_LABEL[stage] || stage);
}

// balIdx: { `${employee_id}_${leave_type}` : balance row }
export function leaveReviewCard(r, { profile, balIdx, onDone }) {
  const p = r.ta_profiles || {};
  const bal = balIdx?.[r.employee_id + '_' + r.leave_type];
  const stage = leaveStage(r);
  const c = el('div.card');

  // ── Who ───────────────────────────────────────────────────────────────────
  const head = el('div.row.between', { style: { marginBottom: '12px', gap: '10px' } });
  const who = el('div.row', { style: { gap: '10px' } });
  who.append(avatar(p, 'sm'),
    el('div', el('div.b', p.full_name || 'Employee'), el('div.tiny.muted', p.department || '—')));
  head.append(who, stagePill(r));
  c.append(head);

  // ── What ──────────────────────────────────────────────────────────────────
  const meta = el('div', { style: { display: 'grid', gap: '8px', marginBottom: '12px' } });
  meta.append(
    metaRow(TYPE_ICON[r.leave_type] || 'briefcase',
      `${TYPE_LABEL[r.leave_type] || r.leave_type} Leave · ${r.days} day${r.days > 1 ? 's' : ''}`),
    metaRow('calendar', `${fmtShortDate(r.start_date)} → ${fmtShortDate(r.end_date)}`),
    metaRow('clock', `Requested ${ago(r.created_at)}`),
    bal ? metaRow('activity',
      `Balance: ${bal.remaining_days} of ${bal.total_days} ${r.leave_type} day(s) left` +
      (stage === 'approved' && r.balance_after != null ? ` · after this: ${r.balance_after}` : '')) : null,
  );
  c.append(meta);

  if (r.reason) {
    c.append(el('p.small.muted', {
      style: { marginBottom: '12px', background: 'var(--surface-2)', padding: '10px 12px', borderRadius: 'var(--r-sm)' },
    }, '“' + r.reason + '”'));
  }

  if (r.attachment_path) c.append(attachmentRow(r));

  // ── Approval trail ────────────────────────────────────────────────────────
  c.append(approvalTrail(r));

  // ── Actions ───────────────────────────────────────────────────────────────
  if (r.status === 'pending') {
    if (canReview(r, profile)) {
      const slot = mySlot(r, profile);
      const short = bal && r.days > bal.remaining_days;
      if (short) {
        c.append(el('div.err-text', { style: { marginBottom: '8px' } },
          `Insufficient balance — this needs ${r.days} day(s) but only ${bal.remaining_days} remain. Final approval will be refused.`));
      }
      c.append(el('div.tiny.muted', { style: { margin: '10px 0 8px' } },
        `You are deciding as the ${slot}.`));
      const bar = el('div.row', { style: { gap: '10px' } });
      const no = el('button.btn.btn--danger.grow.btn--sm', 'Reject');
      const yes = el('button.btn.btn--primary.grow.btn--sm', 'Approve');
      no.addEventListener('click', () => decide(r, 'denied', slot, [no, yes], onDone));
      yes.addEventListener('click', () => decide(r, 'approved', slot, [no, yes], onDone));
      bar.append(no, yes);
      c.append(bar);
    } else {
      c.append(el('div.tiny.muted', { style: { marginTop: '10px' } },
        r.employee_id === profile?.id
          ? 'This is your own request — someone else must review it.'
          : 'You have recorded your decision. Waiting on the other approver.'));
    }
  }
  return c;
}

// Which slot the viewer fills. Mirrors ta_review_leave(): admin slot first for
// someone who happens to be both.
export function mySlot(r, profile) {
  if (profile?.role === 'admin' && r.requires_admin !== false && !r.admin_decision) return 'admin';
  if (profile?.is_manager && r.requires_manager !== false && !r.manager_decision) return 'manager';
  return null;
}

function approvalTrail(r) {
  const box = el('div.trail');
  box.append(trailStep('Manager', r.requires_manager !== false, r.manager_decision, r.manager_at, r.manager_note));
  box.append(trailStep('Admin', r.requires_admin !== false, r.admin_decision, r.admin_at, r.admin_note));
  return box;
}

function trailStep(label, required, decision, at, note) {
  const state = !required ? 'skip' : decision === 'approved' ? 'ok' : decision === 'denied' ? 'no' : 'wait';
  const step = el('div.trail-step.trail-step--' + state);
  const dot = el('span.td', { html: icon(state === 'ok' ? 'check' : state === 'no' ? 'x' : state === 'skip' ? 'minus' : 'clock', 'ic-sm') });
  const txt = el('div.grow');
  txt.append(el('div.tl', label));
  txt.append(el('div.ts',
    state === 'skip' ? 'Not required'
      : state === 'wait' ? 'Awaiting decision'
        : `${decision === 'approved' ? 'Approved' : 'Rejected'} ${at ? ago(at) : ''}`));
  step.append(dot, txt);
  if (note) step.append(el('div.tn', note));
  return step;
}

function attachmentRow(r) {
  const row = el('div.attach-row');
  row.append(el('span.ai', { html: icon('file', 'ic-sm') }));
  const link = el('button.link.grow', { style: { textAlign: 'left' } }, r.attachment_name || 'Attachment');
  link.addEventListener('click', async () => {
    link.disabled = true;
    const prev = link.textContent;
    link.textContent = 'Opening…';
    const url = await signedUrl(r.attachment_path);
    link.disabled = false; link.textContent = prev;
    if (!url) return toastErr('Could not open that attachment. It may have been removed.');
    window.open(url, '_blank', 'noopener');
  });
  row.append(link);
  return row;
}

function decide(r, decision, slot, btns, onDone) {
  const p = r.ta_profiles || {};
  const noteI = el('textarea.textarea', {
    placeholder: decision === 'approved' ? 'Optional note for the employee…' : 'Why is this being rejected? (optional)',
    maxlength: '400', style: { minHeight: '84px' },
  });

  // Will this decision finalise the request, or hand it to the other approver?
  const otherOpen = decision === 'approved' && (
    (slot === 'admin' && r.requires_manager !== false && !r.manager_decision) ||
    (slot === 'manager' && r.requires_admin !== false && !r.admin_decision));

  const body = el('div');
  body.append(el('p.small.muted', { style: { marginBottom: '12px', lineHeight: '1.6' } },
    decision === 'denied'
      ? `${p.full_name || 'This employee'}'s ${r.leave_type} leave will be rejected immediately. No days are deducted and their balance is unchanged.`
      : otherOpen
        ? `Your ${slot} approval is recorded and the request moves to the ${slot === 'admin' ? 'manager' : 'admin'}. No days are deducted yet — the balance only changes once every approval is in.`
        : `This is the final approval. ${r.days} day(s) will be deducted from ${p.full_name || 'the employee'}'s ${r.leave_type} balance and they will be notified.`),
    noteI);

  modal({
    title: decision === 'approved' ? 'Approve leave?' : 'Reject leave?',
    body,
    actions: [
      { label: 'Cancel', cls: 'btn--pill-line' },
      {
        label: decision === 'approved' ? (otherOpen ? 'Approve & pass on' : 'Approve') : 'Reject',
        cls: decision === 'approved' ? 'btn--primary' : 'btn--danger',
        onClick: async (close) => {
          close();
          btns.forEach(b => b.disabled = true);
          try {
            const updated = await Leaves.review(r.id, decision, noteI.value.trim() || null);
            const stage = leaveStage(updated);
            toastOk(decision === 'denied' ? 'Leave rejected'
              : stage === 'approved' ? 'Leave approved — balance updated'
                : `Approved — ${STAGE_LABEL[stage].toLowerCase()}`);
            onDone && onDone();
          } catch (e) { toastErr(e.message); btns.forEach(b => b.disabled = false); }
        },
      },
    ],
  });
}

function metaRow(ic, text) {
  const r = el('div.row', { style: { gap: '9px' } });
  r.append(el('span', { style: { color: 'var(--muted)', display: 'flex' }, html: icon(ic, 'ic-sm') }),
    el('span.small', text));
  return r;
}

// Warns when dual approval is on but nobody can fill the manager slot, which
// would leave every request stuck at "Waiting for Manager" forever.
export function approverGapBanner(cfg, managerCount, { isAdmin }) {
  if (!cfg || cfg.require_manager_approval === false || managerCount > 0) return null;
  const b = el('div.banner.banner--warn');
  b.append(el('span.bi', { html: icon('alert') }));
  b.append(el('div.grow',
    el('div.b.small', 'No managers are assigned'),
    el('p.tiny', { style: { marginTop: '3px', lineHeight: '1.5' } },
      isAdmin
        ? 'Manager approval is required, but nobody has manager rights — leave requests can never be fully approved. Give someone manager rights in Employees, or turn manager approval off below.'
        : 'Manager approval is required but nobody has manager rights yet. Ask your admin to assign one.')));
  return b;
}
