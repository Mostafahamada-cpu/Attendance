import { RestDays, OffDays, Leaves } from '../../lib/data.js?v=20260820a';
import { el, icon, ring, pageHead, emptyState, pill } from '../../lib/ui.js?v=20260820a';
import { toastOk, toastErr, confirmDialog } from '../../lib/toast.js?v=20260820a';
import { ymd, todayYMD, daysBetween, fmtShortDate, fmtDayMon, ago, DOW } from '../../lib/time.js?v=20260820a';

// Employee view: request rest days.
//   1. Pick the DURATION of the rest period (from → to).
//   2. Tick the EXACT dates inside it you want to take.
// Availability = total − used − days already reserved by pending requests.
// The same check runs again inside ta_request_rest_days(), so trimming the
// request in devtools changes nothing.
export default async function restDaysPage({ profile, navigate, refresh }) {
  const [bal, requests, off, leaves] = await Promise.all([
    RestDays.balance().catch(() => null),
    RestDays.mine(),
    OffDays.mine(),
    Leaves.mine().catch(() => []),
  ]);

  const total = bal?.total_days ?? 0;
  const usedDays = bal?.used_days ?? 0;
  const remaining = bal?.remaining_days ?? 0;
  const pendingDays = RestDays.pendingDays(requests);
  const available = Math.max(0, remaining - pendingDays);

  const offSet = new Set(off.map(o => o.day_of_week));
  // Dates already taken by a live rest request …
  const takenRest = new Set();
  for (const r of requests) {
    if (r.status === 'pending' || r.status === 'approved') for (const d of (r.dates || [])) takenRest.add(d);
  }
  // … and by a live leave request.
  const takenLeave = new Set();
  for (const l of leaves) {
    if (l.status === 'denied') continue;
    for (let d = new Date(l.start_date + 'T00:00:00'); ymd(d) <= l.end_date; d.setDate(d.getDate() + 1)) takenLeave.add(ymd(d));
  }

  const screen = el('div.screen.fade-up');
  screen.append(pageHead('Rest Days', () => navigate('#/more')));

  // ── Balance card ──────────────────────────────────────────────────────────
  const balCard = el('div.card');
  const balRow = el('div.row', { style: { gap: '18px' } });
  balRow.append(ring({ value: available, max: total || 1, size: 96, stroke: 10, color: 'var(--teal)', label: available, sub: 'available' }));
  const balLegend = el('div.col.grow', { style: { gap: '9px' } });
  balLegend.append(
    balRow2('Total allotted', total),
    balRow2('Used', usedDays),
    balRow2('Reserved by pending', pendingDays),
    balRow2('Available to request', available, true),
  );
  balRow.append(balLegend);
  balCard.append(balRow);
  screen.append(balCard);

  if (!bal) {
    screen.append(el('div.card', { style: { marginTop: '14px' } },
      emptyState('alert', 'No rest-day balance yet',
        'Your rest-day allotment hasn\'t been set up. Ask your admin to assign one.')));
    return screen;
  }

  // ── Request form ──────────────────────────────────────────────────────────
  const card = el('div.card', { style: { marginTop: '14px' } });
  screen.append(card);

  if (available === 0) {
    card.append(emptyState('moon', 'No rest days available',
      pendingDays > 0
        ? `You have no rest days left to request — ${pendingDays} day(s) are already reserved by a pending request, and ${remaining} of ${total} remain in your balance.`
        : `You have used all ${total} of your rest days. Ask your admin if you need more.`));
  } else {
    card.append(el('div.card-title', 'Request rest days'));
    card.append(el('p.small.muted', { style: { margin: '6px 0 16px' } },
      `Choose the period, then tick the exact days you want off. You can request up to ${available} day${available > 1 ? 's' : ''}.`));

    // Step 1 — duration
    card.append(el('label.small.b', { style: { display: 'block', marginBottom: '8px' } }, '1. Rest period'));
    const two = el('div.two');
    const fromI = el('input.input', { type: 'date', value: todayYMD(), min: todayYMD() });
    const toI = el('input.input', { type: 'date', value: todayYMD(), min: todayYMD() });
    two.append(labelled('From', fromI), labelled('To', toI));
    card.append(two);

    const durPill = el('div.pill.pill--plain', { style: { margin: '2px 0 18px' } }, '1 day period');
    card.append(durPill);

    // Step 2 — exact dates
    card.append(el('label.small.b', { style: { display: 'block', marginBottom: '8px' } }, '2. Exact rest days'));
    const dayGrid = el('div.rest-grid');
    card.append(dayGrid);

    const counter = el('div.rest-counter');
    card.append(counter);

    const reasonF = el('div.field', { style: { marginTop: '16px' } });
    reasonF.append(el('label', 'Reason (optional)'));
    const reason = el('textarea.textarea', { placeholder: 'Anything the admin should know…', maxlength: '400', style: { minHeight: '84px' } });
    reasonF.append(reason);
    card.append(reasonF);

    const submit = el('button.btn.btn--primary.btn--block');
    submit.innerHTML = icon('moon') + '<span>Submit rest-day request</span>';
    card.append(submit);

    const selected = new Set();

    function periodDates() {
      const s = fromI.value, e = toI.value;
      if (!s || !e || e < s) return [];
      const out = [];
      for (const d = new Date(s + 'T00:00:00'); ymd(d) <= e; d.setDate(d.getDate() + 1)) out.push(ymd(d));
      return out.slice(0, 62);           // UI guard; the server caps at 31 selected
    }

    // Why a date can't be picked — null when it's selectable.
    function blockedReason(date) {
      if (date < todayYMD()) return 'Past';
      if (offSet.has(new Date(date + 'T00:00:00').getDay())) return 'Weekly off';
      if (takenRest.has(date)) return 'Rest request';
      if (takenLeave.has(date)) return 'On leave';
      return null;
    }

    function drawDays() {
      const dates = periodDates();
      dayGrid.replaceChildren();
      // Drop selections that fell outside the new period.
      for (const d of [...selected]) if (!dates.includes(d)) selected.delete(d);

      if (!dates.length) {
        dayGrid.append(el('p.small', { style: { color: 'var(--danger)', fontWeight: '600' } }, 'Pick a valid period — the end date must not be before the start date.'));
        sync(); return;
      }
      for (const date of dates) {
        const why = blockedReason(date);
        const dt = new Date(date + 'T00:00:00');
        const cell = el('button.rest-day' + (why ? '.off' : '') + (selected.has(date) ? '.on' : ''),
          { type: 'button', title: why || 'Tap to select', 'aria-pressed': selected.has(date) ? 'true' : 'false' });
        cell.append(
          el('span.rd-dow', DOW[dt.getDay()]),
          el('span.rd-num', String(dt.getDate())),
          el('span.rd-mo', why || fmtDayMon(date).split(' ')[0]),
        );
        if (!why) cell.addEventListener('click', () => {
          if (selected.has(date)) selected.delete(date);
          else {
            if (selected.size >= available) return toastErr(`You only have ${available} rest day${available > 1 ? 's' : ''} available.`);
            selected.add(date);
          }
          cell.classList.toggle('on', selected.has(date));
          cell.setAttribute('aria-pressed', selected.has(date) ? 'true' : 'false');
          sync();
        });
        else cell.disabled = true;
        dayGrid.append(cell);
      }
      sync();
    }

    function sync() {
      const n = selected.size;
      const over = n > available;
      counter.replaceChildren(
        el('span.rc-n' + (over ? '.bad' : ''), `${n} selected`),
        el('span.rc-s', `of ${available} available`),
      );
      counter.className = 'rest-counter' + (over ? ' rest-counter--bad' : '');
      const dates = periodDates();
      durPill.textContent = dates.length ? `${dates.length} day period` : 'Invalid period';
      durPill.className = 'pill ' + (dates.length ? 'pill--plain' : 'pill--denied');
      submit.disabled = n === 0 || over;
    }

    fromI.addEventListener('change', () => {
      if (toI.value < fromI.value) toI.value = fromI.value;
      toI.min = fromI.value;
      drawDays();
    });
    toI.addEventListener('change', drawDays);
    drawDays();

    submit.addEventListener('click', () => {
      const dates = [...selected].sort();
      if (!dates.length) return toastErr('Select at least one rest day.');
      // Local mirror of the server rule — the RPC checks it again regardless.
      if (dates.length > available) {
        return toastErr(`You do not have enough available rest days. You selected ${dates.length} but only ${available} remain.`);
      }
      confirmDialog({
        title: 'Submit rest-day request?',
        message: `${dates.length} rest day${dates.length > 1 ? 's' : ''} (${fmtShortDate(dates[0])}${dates.length > 1 ? ' → ' + fmtShortDate(dates[dates.length - 1]) : ''}). ` +
          `You'll have ${available - dates.length} available while this is pending.`,
        confirmLabel: 'Submit',
        onConfirm: async () => {
          submit.disabled = true; submit.querySelector('span').textContent = 'Submitting…';
          try {
            await RestDays.request(dates, reason.value.trim() || null);
            toastOk('Rest-day request submitted');
            refresh();
          } catch (e) {
            toastErr(e.message);
            submit.disabled = false;
            submit.querySelector('span').textContent = 'Submit rest-day request';
          }
        },
      });
    });
  }

  // ── My requests ───────────────────────────────────────────────────────────
  screen.append(el('div.section-h', el('h2', 'My rest-day requests')));
  if (!requests.length) {
    screen.append(el('div.card', emptyState('moon', 'No rest days requested yet', 'Requests you submit will appear here.')));
  } else {
    const list = el('div.list');
    for (const r of requests) list.append(requestCard(r));
    screen.append(list);
  }

  return screen;
}

export function requestCard(r) {
  const c = el('div.card.card--flat');
  const head = el('div.row.between', { style: { marginBottom: '10px' } });
  head.append(el('div.b.small', `${r.days_count} rest day${r.days_count > 1 ? 's' : ''}`), pill(r.status));
  c.append(head);

  const chips = el('div.row.wrap', { style: { gap: '6px' } });
  for (const d of (r.dates || [])) chips.append(el('span.pill.pill--plain', { style: { height: '24px', fontSize: '11.5px' } }, fmtDayMon(d)));
  c.append(chips);

  c.append(el('div.tiny.muted', { style: { marginTop: '10px' } },
    `Requested ${ago(r.created_at)} · balance before: ${r.balance_before}` +
    (r.balance_after != null ? ` · after: ${r.balance_after}` : '')));
  if (r.reason) c.append(el('p.tiny.muted', { style: { marginTop: '6px' } }, '“' + r.reason + '”'));
  if (r.admin_note) c.append(el('p.tiny', { style: { marginTop: '6px', color: 'var(--ink-2)' } }, 'Admin: ' + r.admin_note));
  return c;
}

function labelled(label, input) {
  const f = el('div.field');
  f.append(el('label', label), input);
  return f;
}

function balRow2(label, value, strong) {
  const r = el('div.row.between');
  r.append(el('span.small' + (strong ? '.b' : '.muted'), label),
    el('span.b' + (strong ? '' : '.small'), String(value) + ' day' + (value === 1 ? '' : 's')));
  return r;
}
