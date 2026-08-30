import { Profiles, OffDays } from '../../lib/data.js?v=20260830a';
import { el, icon, avatar, emptyState } from '../../lib/ui.js?v=20260830a';
import { toastOk, toastErr } from '../../lib/toast.js?v=20260830a';
import { DOW_FULL, DOW } from '../../lib/time.js?v=20260830a';

export default async function adminOffdays() {
  const people = (await Profiles.all()).filter(p => p.role === 'employee');

  const screen = el('div.fade-up');
  screen.append(el('div', { style: { marginBottom: '20px' } },
    el('h1', { style: { fontSize: '26px', fontWeight: '800' } }, 'Weekly Off-Days'),
    el('p.muted.small', 'Set each employee\'s weekly rest days — the calendar uses these instead of hardcoded weekends')));

  if (!people.length) { screen.append(el('div.card', emptyState('users', 'No employees yet'))); return screen; }

  const grid = el('div', { style: { display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))' } });
  screen.append(grid);

  for (const p of people) grid.append(await empCard(p));
  return screen;
}

async function empCard(p) {
  const current = new Set((await OffDays.mine(p.id)).map(o => o.day_of_week));
  const card = el('div.card');
  const head = el('div.row', { style: { gap: '10px', marginBottom: '14px' } });
  head.append(avatar(p, 'sm'), el('div.grow', el('div.b', p.full_name), el('div.tiny.muted', p.department || '—')));
  card.append(head);

  const chips = el('div.row.wrap', { style: { gap: '6px', marginBottom: '14px' } });
  const selected = new Set(current);
  for (let d = 0; d < 7; d++) {
    const chip = el('button', { style: chipStyle(selected.has(d)) }, DOW[d]);
    chip.addEventListener('click', () => {
      if (selected.has(d)) selected.delete(d); else selected.add(d);
      Object.assign(chip.style, chipStyle(selected.has(d)));
    });
    chips.append(chip);
  }
  card.append(chips);

  const save = el('button.btn.btn--primary.btn--sm.btn--block', 'Save off-days');
  save.addEventListener('click', async () => {
    save.disabled = true; save.textContent = 'Saving…';
    try { await OffDays.set(p.id, [...selected].sort()); toastOk(`Off-days updated for ${p.full_name.split(' ')[0]}`); }
    catch (e) { toastErr(e.message); }
    finally { save.disabled = false; save.textContent = 'Save off-days'; }
  });
  card.append(save);
  return card;
}

function chipStyle(on) {
  return {
    height: '38px', padding: '0 14px', borderRadius: '99px', fontSize: '13px', fontWeight: '700',
    background: on ? 'var(--teal)' : 'var(--surface-2)', color: on ? '#fff' : 'var(--ink-2)',
    transition: 'all .15s',
  };
}
