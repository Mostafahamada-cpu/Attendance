-- ============================================================================
--  RingRoad Attendance — SCHEMA v4
--  ADMIN VACATION / LEAVE BALANCE MANAGEMENT
--  ---------------------------------------------------------------------------
--  Run AFTER schema.sql, schema-v2.sql and schema-v3.sql, in the Supabase
--  SQL Editor. Additive and idempotent — it never drops a table or a row.
--
--  WHAT IT ADDS
--  ------------
--   1. ta_balance_adjustments — an append-only audit trail of every manual
--      change an admin makes to a vacation balance (who, when, from, to, why).
--   2. ta_set_leave_balance(employee, type, total, note)   — set ONE type.
--   3. ta_set_leave_balances(employee, casual, medical, planned, note)
--      — set all three ATOMICALLY in a single call; NULL means "leave alone".
--      Both are SECURITY DEFINER, admin-gated, and notify the employee.
--   4. RLS/GRANT tightening: ta_leave_balances becomes READ-ONLY over PostgREST
--      for EVERY role, including admins. The RPCs above are the only write
--      path, so the "total can never fall below days already used" rule and the
--      audit trail cannot be skipped by a hand-crafted PATCH.
--
--  WHY AN RPC INSTEAD OF THE EXISTING UPDATE POLICY
--  ------------------------------------------------
--  schema.sql shipped `ta_bal_upd`, letting an admin PATCH the table directly.
--  That allowed `used_days` to be written to any value — silently desynchronising
--  the balance from the approved leave that produced it — and left no record of
--  who changed what. `total_days` is the only field a human should ever set;
--  `used_days` belongs to ta_review_leave().
--
--  EMPLOYEES CANNOT EDIT THEIR OWN BALANCE. They hold SELECT on their own row
--  and nothing else; the RPCs raise unless ta_is_admin() is true.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. AUDIT TRAIL
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ta_balance_adjustments (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.ta_profiles(id) on delete cascade,
  leave_type   ta_leave_type not null,
  total_before integer not null,
  total_after  integer not null,
  used_days    integer not null,          -- used_days at the moment of the change
  changed_by   uuid references public.ta_profiles(id),
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_ta_baladj_emp on public.ta_balance_adjustments(employee_id);
create index if not exists idx_ta_baladj_at  on public.ta_balance_adjustments(created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. SET ONE LEAVE TYPE'S TOTAL
-- ─────────────────────────────────────────────────────────────────────────────
--  Upserts the row (someone provisioned before a type existed may have no row
--  yet), refuses a total below the days already used, writes the audit row and
--  notifies the employee. Returns the stored balance so the caller renders the
--  authoritative numbers rather than guessing at them.
create or replace function public.ta_set_leave_balance(
  p_employee   uuid,
  p_leave_type ta_leave_type,
  p_total      integer,
  p_note       text default null)
returns public.ta_leave_balances
language plpgsql security definer set search_path = public as $fn$
declare
  b      public.ta_leave_balances;
  before integer := 0;
  used   integer := 0;
  who    text;
begin
  if not public.ta_is_admin() then
    raise exception 'Only an admin can change a vacation balance' using errcode = 'P0001';
  end if;
  if p_employee is null then
    raise exception 'No employee given.' using errcode = 'P0001';
  end if;
  if p_total is null or p_total < 0 then
    raise exception 'The total must be 0 days or more.' using errcode = 'P0001';
  end if;
  if p_total > 365 then
    raise exception 'The total cannot exceed 365 days.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.ta_profiles where id = p_employee) then
    raise exception 'Employee not found.' using errcode = 'P0001';
  end if;

  -- Lock the row so two admins editing at once cannot race past the used check.
  select * into b from public.ta_leave_balances
   where employee_id = p_employee and leave_type = p_leave_type for update;

  if found then
    before := b.total_days;
    used   := b.used_days;
    if p_total < used then
      raise exception '% has already used % % day(s) — the total cannot be lower than that.',
        coalesce((select full_name from public.ta_profiles where id = p_employee), 'This employee'),
        used, p_leave_type using errcode = 'P0001';
    end if;
  end if;

  insert into public.ta_leave_balances (employee_id, leave_type, total_days)
  values (p_employee, p_leave_type, p_total)
  on conflict (employee_id, leave_type) do update set total_days = excluded.total_days
  returning * into b;

  -- Nothing actually moved — do not pad the audit log or ping the employee.
  if before = b.total_days then
    return b;
  end if;

  insert into public.ta_balance_adjustments
    (employee_id, leave_type, total_before, total_after, used_days, changed_by, note)
  values (p_employee, p_leave_type, before, b.total_days, used, auth.uid(), nullif(btrim(p_note), ''));

  select full_name into who from public.ta_profiles where id = auth.uid();
  insert into public.ta_notifications (employee_id, title, message, type)
  values (p_employee, 'Vacation balance updated',
          format('Your %s leave allowance was changed from %s to %s day(s) by %s. You now have %s day(s) remaining.',
                 p_leave_type, before, b.total_days, coalesce(who, 'an administrator'), b.remaining_days),
          'balance_updated');

  return b;
end $fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. SET ALL THREE TOTALS AT ONCE (atomic)
-- ─────────────────────────────────────────────────────────────────────────────
--  The admin dialog edits Casual / Medical / Planned together, so this runs the
--  three updates inside ONE transaction: if the medical figure is rejected, the
--  casual one is rolled back with it and the admin sees the untouched original
--  rather than a half-applied edit. NULL = "do not change this type".
create or replace function public.ta_set_leave_balances(
  p_employee uuid,
  p_casual   integer default null,
  p_medical  integer default null,
  p_planned  integer default null,
  p_note     text    default null)
returns setof public.ta_leave_balances
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.ta_is_admin() then
    raise exception 'Only an admin can change a vacation balance' using errcode = 'P0001';
  end if;
  if p_casual is null and p_medical is null and p_planned is null then
    raise exception 'Nothing to update.' using errcode = 'P0001';
  end if;

  if p_casual  is not null then perform public.ta_set_leave_balance(p_employee, 'casual'::ta_leave_type,  p_casual,  p_note); end if;
  if p_medical is not null then perform public.ta_set_leave_balance(p_employee, 'medical'::ta_leave_type, p_medical, p_note); end if;
  if p_planned is not null then perform public.ta_set_leave_balance(p_employee, 'planned'::ta_leave_type, p_planned, p_note); end if;

  return query
    select * from public.ta_leave_balances
     where employee_id = p_employee order by leave_type;
end $fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. BACKFILL — make sure every profile has all three balance rows
-- ─────────────────────────────────────────────────────────────────────────────
--  Anyone created before a type existed would otherwise show "—" in the admin
--  table with nothing to edit.
insert into public.ta_leave_balances (employee_id, leave_type, total_days)
select p.id, t.lt, t.days
from public.ta_profiles p
cross join (values ('casual'::ta_leave_type, 12),
                   ('medical'::ta_leave_type, 8),
                   ('planned'::ta_leave_type, 5)) as t(lt, days)
on conflict (employee_id, leave_type) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ROW LEVEL SECURITY
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.ta_balance_adjustments enable row level security;

--  Audit trail: an employee may read their own history (it explains a change
--  they were notified about); admins read everything. Nobody writes directly —
--  only ta_set_leave_balance(), which runs as the function owner.
drop policy if exists ta_baladj_sel on public.ta_balance_adjustments;
create policy ta_baladj_sel on public.ta_balance_adjustments for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin());

--  Balances: READ ONLY over the API for everyone.
--  Employees keep SELECT on their own row (schema-v3 also lets a manager read a
--  balance beside a request they are reviewing). The write policies are dropped
--  outright: with no INSERT/UPDATE policy, RLS denies those commands to every
--  authenticated user — admins included — so ta_set_leave_balance() is the only
--  way a total can move, and ta_review_leave() the only way `used_days` can.
drop policy if exists ta_bal_upd on public.ta_leave_balances;
drop policy if exists ta_bal_ins on public.ta_leave_balances;
drop policy if exists ta_bal_del on public.ta_leave_balances;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. GRANTS
-- ─────────────────────────────────────────────────────────────────────────────
--  Belt and braces: revoke the table privileges too, so the request is refused
--  with 42501 before RLS is even consulted.
revoke insert, update, delete on public.ta_leave_balances from authenticated;
grant  select on public.ta_leave_balances       to authenticated;
grant  select on public.ta_balance_adjustments  to authenticated;

grant execute on function public.ta_set_leave_balance(uuid, ta_leave_type, integer, text)    to authenticated;
grant execute on function public.ta_set_leave_balances(uuid, integer, integer, integer, text) to authenticated;

-- ============================================================================
--  DONE. Sanity checks — run these after the migration.
-- ----------------------------------------------------------------------------
--  a) Balances are read-only over the API (both should be FALSE):
--       select has_table_privilege('authenticated','public.ta_leave_balances','UPDATE') as upd,
--              has_table_privilege('authenticated','public.ta_leave_balances','INSERT') as ins;
--
--  b) Everyone has all three types (expect 0 rows):
--       select p.full_name, count(b.*) as types
--         from public.ta_profiles p
--         left join public.ta_leave_balances b on b.employee_id = p.id
--        group by p.full_name having count(b.*) <> 3;
--
--  c) The audit trail, newest first:
--       select a.created_at, e.full_name as employee, a.leave_type,
--              a.total_before, a.total_after, a.used_days,
--              w.full_name as changed_by, a.note
--         from public.ta_balance_adjustments a
--         join public.ta_profiles e on e.id = a.employee_id
--         left join public.ta_profiles w on w.id = a.changed_by
--        order by a.created_at desc limit 50;
-- ============================================================================
