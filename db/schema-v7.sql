-- ============================================================================
--  RingRoad — Attendance & Time-Off :: MIGRATION v7
--  SALARY RULES · WORK SHIFTS · PAYROLL · MONTHLY LEAVE PERMISSIONS
--  ---------------------------------------------------------------------------
--  Run AFTER schema.sql, schema-v2.sql, schema-v3.sql and schema-v4.sql.
--  Idempotent — safe to re-run.
--
--  What this adds
--  ---------------------------------------------------------------------------
--   • ta_shifts              — the three company work shifts (09/10/11 starts).
--   • ta_salary_rules        — ONE row per employee: salary, shift, grace,
--                              late rate, absence rule, permission rules,
--                              active flag. Weekly days off keep living in the
--                              EXISTING ta_weekly_off_days table — the schedule
--                              is never duplicated.
--   • ta_holidays            — company holidays (never an absence).
--   • ta_payroll_adjustments — manual "other deductions", per employee, month.
--   • ta_leave_permissions   — permission to step out DURING a working day.
--                              3 per calendar month are auto-approved; #4 and
--                              beyond go to the admin as Pending.
--   • ta_payroll()           — the whole monthly calculation, DERIVED from
--                              attendance every time it is called.
--
--  LEAVE PERMISSIONS ARE NOT VACATION
--  ---------------------------------------------------------------------------
--  ta_leave_requests (vacation: whole days, deducts a balance, two-stage
--  approval) and ta_leave_permissions (hours inside one working day, 3 free
--  per month, no balance) are separate tables, separate RPCs and separate
--  screens. Nothing in this migration touches the vacation system.
--
--  IDEMPOTENCE
--  ---------------------------------------------------------------------------
--  There is deliberately NO "deductions" table that the app writes to on load.
--  Late, absence and permission money is computed from ta_attendance /
--  ta_leave_requests / ta_leave_permissions / ta_weekly_off_days on demand, so
--  refreshing the dashboard a hundred times produces the same numbers a hundred
--  times. The only stored money rows are ta_payroll_adjustments, which an admin
--  creates by hand and which carry a unique (employee, month, label) index.
--
--  SECURITY
--  ---------------------------------------------------------------------------
--  ta_salary_rules and ta_payroll_adjustments are READ-ONLY over the API for
--  everyone, admins included: no INSERT/UPDATE/DELETE policy exists and the
--  grants are revoked, so PostgREST refuses the write with 42501 before RLS is
--  even consulted. ta_leave_permissions is read-only too — an employee creates
--  one through an RPC that decides the status, so nobody can self-approve.
--  Every privileged change goes through a SECURITY DEFINER function that first
--  checks ta_is_admin(). An employee reads only their OWN rules, their OWN
--  permissions and their OWN payroll.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. ENUMS
-- ─────────────────────────────────────────────────────────────────────────────
--  Deliberately NOT reusing ta_leave_status: a permission can be 'cancelled',
--  a vacation request cannot, and the vacation vocabulary says 'denied' where
--  permissions say 'rejected'.
do $$ begin
  create type ta_permission_status as enum ('approved', 'pending', 'rejected', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type ta_permission_approval as enum ('automatic', 'admin');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. SETTINGS — company timezone + the defaults new employees inherit
-- ─────────────────────────────────────────────────────────────────────────────
--  The timezone is the ONE place the intended local time is defined. Every
--  lateness comparison converts the stored timestamptz into it, so the answer
--  never depends on the admin's browser or on the database server's zone.
alter table public.ta_settings
  add column if not exists timezone                 text          not null default 'Africa/Cairo',
  add column if not exists default_salary           numeric(12,2) not null default 6000,
  add column if not exists default_grace_minutes    integer       not null default 15,
  add column if not exists default_late_per_minute  numeric(10,2) not null default 1,
  add column if not exists permissions_per_month    integer       not null default 3;

do $$ begin
  alter table public.ta_settings add constraint ta_settings_grace_ck
    check (default_grace_minutes between 0 and 240);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.ta_settings add constraint ta_settings_salary_ck
    check (default_salary >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.ta_settings add constraint ta_settings_latepm_ck
    check (default_late_per_minute >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.ta_settings add constraint ta_settings_perm_ck
    check (permissions_per_month between 0 and 31);
exception when duplicate_object then null; end $$;

-- The company's local time, right now. Everything date-shaped in payroll is
-- anchored to this, never to the caller's clock.
create or replace function public.ta_now_local()
returns timestamp language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce(
    (select timezone from public.ta_settings where id = true), 'Africa/Cairo'));
$$;

create or replace function public.ta_today_local()
returns date language sql stable security definer set search_path = public as $$
  select public.ta_now_local()::date;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. WORK SHIFTS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ta_shifts (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  name        text not null,
  start_time  time not null,
  end_time    time not null,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  updated_by  uuid references public.ta_profiles(id),
  updated_at  timestamptz not null default now(),
  check (end_time <> start_time)
);

--  The three shifts the company runs. `code` is stable, so re-running the
--  migration never creates a fourth copy and never overwrites times an admin
--  has since edited.
insert into public.ta_shifts (code, name, start_time, end_time, sort_order) values
  ('shift_1', 'Shift 1', '09:00', '17:00', 1),
  ('shift_2', 'Shift 2', '10:00', '18:00', 2),
  ('shift_3', 'Shift 3', '11:00', '19:00', 3)
on conflict (code) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. COMPANY HOLIDAYS
-- ─────────────────────────────────────────────────────────────────────────────
--  A holiday is never a working day and therefore never an absence, for anyone.
create table if not exists public.ta_holidays (
  holiday_date date primary key,
  name         text not null default 'Holiday',
  created_by   uuid references public.ta_profiles(id),
  created_at   timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. PER-EMPLOYEE SALARY & ATTENDANCE RULES  (1:1 with ta_profiles)
-- ─────────────────────────────────────────────────────────────────────────────
--  This EXTENDS the existing employee record — it does not duplicate it. There
--  is no second name/department/email here; the FK is the whole identity.
--  Weekly days off are NOT stored here either: ta_weekly_off_days already owns
--  them and is already admin-write-only.
create table if not exists public.ta_salary_rules (
  employee_id                uuid primary key references public.ta_profiles(id) on delete cascade,
  monthly_salary             numeric(12,2) not null default 6000 check (monthly_salary >= 0),
  shift_id                   uuid references public.ta_shifts(id) on delete set null,
  -- Set either of these to give ONE employee times that differ from the shift.
  shift_start_override       time,
  shift_end_override         time,
  grace_minutes              integer not null default 15 check (grace_minutes between 0 and 240),
  late_deduction_per_minute  numeric(10,2) not null default 1 check (late_deduction_per_minute >= 0),
  -- Optional ceiling so one very late morning can't wipe out a salary.
  late_deduction_cap_per_day numeric(12,2) check (late_deduction_cap_per_day is null or late_deduction_cap_per_day >= 0),
  -- How the daily rate behind an absence deduction is derived:
  --   'scheduled'  → salary ÷ the employee's scheduled working days THAT month
  --                  (respects their own days off and the holiday calendar)
  --   'fixed_days' → salary ÷ absence_fixed_days (a flat 26- or 30-day month)
  absence_basis              text not null default 'scheduled'
                               check (absence_basis in ('scheduled','fixed_days')),
  absence_fixed_days         integer not null default 26 check (absence_fixed_days between 1 and 31),
  -- 1 = one day's pay per absent day. 2 = a double penalty, 0.5 = half.
  absence_multiplier         numeric(6,3) not null default 1 check (absence_multiplier >= 0),
  is_active                  boolean not null default true,
  note                       text,
  updated_by                 uuid references public.ta_profiles(id),
  updated_at                 timestamptz not null default now()
);
create index if not exists idx_ta_salrules_active on public.ta_salary_rules(is_active);

-- ── v7 leave-permission rules, per employee ─────────────────────────────────
--  OFF by default: an approved permission costs nothing unless an admin turns
--  the deduction on for that specific employee.
alter table public.ta_salary_rules
  add column if not exists permissions_per_month        integer       not null default 3,
  add column if not exists permission_deduction_enabled boolean       not null default false,
  add column if not exists permission_deduction_mode    text          not null default 'per_minute',
  add column if not exists permission_deduction_rate    numeric(10,2) not null default 0;

do $$ begin
  alter table public.ta_salary_rules add constraint ta_salrules_permcount_ck
    check (permissions_per_month between 0 and 31);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.ta_salary_rules add constraint ta_salrules_permmode_ck
    check (permission_deduction_mode in ('per_minute','per_occurrence','fixed'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.ta_salary_rules add constraint ta_salrules_permrate_ck
    check (permission_deduction_rate >= 0);
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. MANUAL PAYROLL ADJUSTMENTS  ("Other deductions")
-- ─────────────────────────────────────────────────────────────────────────────
--  Everything automatic (late, absence, permissions) is DERIVED and stored
--  nowhere. This table holds only what an admin typed in on purpose — an
--  advance, a fine, a damaged-equipment charge — so a page refresh can never
--  invent one.
create table if not exists public.ta_payroll_adjustments (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.ta_profiles(id) on delete cascade,
  -- Always the FIRST day of the month it belongs to.
  period_month date not null check (extract(day from period_month) = 1),
  label        text not null check (length(btrim(label)) > 0),
  amount       numeric(12,2) not null check (amount >= 0),
  note         text,
  created_by   uuid references public.ta_profiles(id),
  created_at   timestamptz not null default now()
);
create index if not exists idx_ta_payadj_emp    on public.ta_payroll_adjustments(employee_id);
create index if not exists idx_ta_payadj_period on public.ta_payroll_adjustments(period_month);

--  One label per employee per month: re-adding the same charge is an UPDATE,
--  not a second row. This is what makes "apply the September fine" safe to
--  repeat.
create unique index if not exists uq_ta_payadj_slot
  on public.ta_payroll_adjustments(employee_id, period_month, lower(btrim(label)));

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. MONTHLY LEAVE PERMISSIONS
-- ─────────────────────────────────────────────────────────────────────────────
--  Permission to be away for part of ONE working day. Three per calendar month
--  are approved the moment they are submitted; the fourth and beyond wait for
--  an admin. There is no balance table and no counter column: the usage is
--  COUNTED from the rows themselves, keyed on permission_date, so the 1st of
--  every month starts at 0/3 with nothing to reset.
create table if not exists public.ta_leave_permissions (
  id               uuid primary key default gen_random_uuid(),
  employee_id      uuid not null references public.ta_profiles(id) on delete cascade,
  permission_date  date not null,
  start_time       time not null,
  end_time         time not null,
  duration_minutes integer not null check (duration_minutes > 0),
  reason           text,
  status           ta_permission_status not null default 'pending',
  -- NULL until the request has actually been decided.
  --   'automatic' → inside the monthly allowance, approved on submission
  --   'admin'     → an admin approved or rejected it by hand
  approval_type    ta_permission_approval,
  -- Was this one beyond the allowance when it was submitted?
  requires_approval boolean not null default false,
  -- How many permissions the employee had already used that month (0-based),
  -- frozen at submission time so the audit trail explains the decision.
  used_before      integer not null default 0,
  monthly_limit    integer not null default 3,
  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  decided_by       uuid references public.ta_profiles(id),
  admin_note       text,
  check (end_time > start_time)
);
create index if not exists idx_ta_perm_emp    on public.ta_leave_permissions(employee_id);
create index if not exists idx_ta_perm_date   on public.ta_leave_permissions(permission_date);
create index if not exists idx_ta_perm_status on public.ta_leave_permissions(status);
create index if not exists idx_ta_perm_month
  on public.ta_leave_permissions(employee_id, permission_date)
  where status = 'approved';

-- ============================================================================
--  HELPERS
-- ============================================================================

-- Sensible weekly days off for a role, JS getDay() convention (0=Sun … 6=Sat).
--   Sales           → Friday only          {5}
--   everyone else   → Friday + Saturday    {5,6}
-- Used ONLY to seed an employee who has none yet; it never overwrites a
-- schedule an admin has already set.
create or replace function public.ta_default_off_days(p_position text, p_department text)
returns integer[] language sql immutable as $$
  select case
    when coalesce(p_position,'') || ' ' || coalesce(p_department,'') ilike '%sales%'
      then array[5]
    else array[5,6]
  end;
$$;

-- Make sure an employee has a rules row. Returns it.
--  SECURITY DEFINER and callable by the provisioning trigger; NOT granted to
--  the API (an employee must never be able to conjure their own rules row).
create or replace function public.ta_ensure_salary_rules(p_employee uuid)
returns public.ta_salary_rules language plpgsql security definer set search_path = public as $$
declare
  r   public.ta_salary_rules;
  cfg public.ta_settings;
  p   public.ta_profiles;
begin
  select * into r from public.ta_salary_rules where employee_id = p_employee;
  if found then return r; end if;

  cfg := public.ta_cfg();
  select * into p from public.ta_profiles where id = p_employee;

  insert into public.ta_salary_rules (
    employee_id, monthly_salary, shift_id, grace_minutes,
    late_deduction_per_minute, permissions_per_month)
  values (
    p_employee,
    coalesce(cfg.default_salary, 6000),
    (select id from public.ta_shifts where code = 'shift_2'),
    coalesce(cfg.default_grace_minutes, 15),
    coalesce(cfg.default_late_per_minute, 1),
    coalesce(cfg.permissions_per_month, 3))
  on conflict (employee_id) do nothing
  returning * into r;

  if r.employee_id is null then
    select * into r from public.ta_salary_rules where employee_id = p_employee;
  end if;

  -- Seed the weekly days off ONLY when the employee has none at all.
  if not exists (select 1 from public.ta_weekly_off_days where employee_id = p_employee) then
    insert into public.ta_weekly_off_days (employee_id, day_of_week)
    select p_employee, d
      from unnest(public.ta_default_off_days(p.position, p.department)) as d
    on conflict (employee_id, day_of_week) do nothing;
  end if;

  return r;
end $$;

-- ── Permission usage for one employee in one calendar month ────────────────
--  "Used" counts APPROVED permissions only, whoever approved them. A rejected
--  or cancelled request gives the allowance back; a pending #4 has not
--  consumed anything yet, because it may still be rejected.
create or replace function public.ta_permission_used(p_employee uuid, p_month date)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int
    from public.ta_leave_permissions
   where employee_id = p_employee
     and status = 'approved'
     and permission_date >= date_trunc('month', p_month)::date
     and permission_date <  (date_trunc('month', p_month) + interval '1 month')::date;
$$;

-- The whole counter, ready for the UI: { limit, used, remaining, next_requires_approval }
create or replace function public.ta_permission_usage(
  p_employee uuid default null, p_year integer default null, p_month integer default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_emp   uuid := coalesce(p_employee, auth.uid());
  v_month date;
  v_limit integer;
  v_used  integer;
  v_pend  integer;
begin
  if auth.uid() is null then
    raise exception 'You are not signed in.' using errcode = 'P0001';
  end if;
  if v_emp is distinct from auth.uid() and not public.ta_is_admin() then
    raise exception 'You can only view your own leave permissions.' using errcode = 'P0001';
  end if;

  v_month := case
    when p_year is null or p_month is null then date_trunc('month', public.ta_today_local())::date
    else make_date(p_year, p_month, 1) end;

  v_limit := coalesce(
    (select permissions_per_month from public.ta_salary_rules where employee_id = v_emp),
    (select permissions_per_month from public.ta_settings where id = true), 3);

  v_used := public.ta_permission_used(v_emp, v_month);

  select count(*)::int into v_pend
    from public.ta_leave_permissions
   where employee_id = v_emp and status = 'pending'
     and permission_date >= v_month
     and permission_date < (v_month + interval '1 month')::date;

  return jsonb_build_object(
    'employee_id', v_emp,
    'month', to_char(v_month, 'YYYY-MM-DD'),
    'limit', v_limit,
    'used', v_used,
    'pending', v_pend,
    'remaining', greatest(0, v_limit - v_used),
    'next_requires_approval', v_used >= v_limit);
end $$;

-- ============================================================================
--  LEAVE PERMISSION RPCs
-- ============================================================================

-- ── SUBMIT ──────────────────────────────────────────────────────────────────
--  The status is decided HERE, by the database, from a count it does itself.
--  The client sends a date, a window and a reason — nothing else — so no
--  employee can talk their way into an approval.
create or replace function public.ta_request_permission(
  p_date date, p_start time, p_end time, p_reason text default null)
returns public.ta_leave_permissions language plpgsql security definer set search_path = public as $$
declare
  uid     uuid := auth.uid();
  rec     public.ta_leave_permissions;
  v_month date;
  v_limit integer;
  v_used  integer;
  v_mins  integer;
  v_auto  boolean;
  v_name  text;
begin
  if uid is null then
    raise exception 'You are not signed in.' using errcode = 'P0001';
  end if;
  if p_date is null or p_start is null or p_end is null then
    raise exception 'Pick a date, a start time and an end time.' using errcode = 'P0001';
  end if;
  if p_end <= p_start then
    raise exception 'The end time must be after the start time.' using errcode = 'P0001';
  end if;

  v_mins := (extract(epoch from (p_end - p_start)) / 60)::int;
  if v_mins < 5 then
    raise exception 'A leave permission must be at least 5 minutes.' using errcode = 'P0001';
  end if;
  if v_mins > 12 * 60 then
    raise exception 'A leave permission covers part of one working day, not more than 12 hours.'
      using errcode = 'P0001';
  end if;

  -- Requests are for today or the near future; back-dating attendance is an
  -- admin job, not a self-service one.
  if p_date < public.ta_today_local() then
    raise exception 'You cannot request a permission for a date that has already passed.'
      using errcode = 'P0001';
  end if;
  if p_date > public.ta_today_local() + 90 then
    raise exception 'Leave permissions can be requested up to 90 days ahead.' using errcode = 'P0001';
  end if;

  -- One window at a time on a given day.
  if exists (select 1 from public.ta_leave_permissions x
              where x.employee_id = uid and x.permission_date = p_date
                and x.status in ('approved','pending')
                and x.start_time < p_end and x.end_time > p_start) then
    raise exception 'You already have a leave permission covering part of that time.'
      using errcode = 'P0001';
  end if;

  -- A permission is time away from a WORKING day. Approved vacation already
  -- covers the whole day, so the two would contradict each other.
  if exists (select 1 from public.ta_leave_requests l
              where l.employee_id = uid and l.status = 'approved'
                and p_date between l.start_date and l.end_date) then
    raise exception 'You are already on approved leave that day.' using errcode = 'P0001';
  end if;

  v_month := date_trunc('month', p_date)::date;
  v_limit := coalesce(
    (select permissions_per_month from public.ta_salary_rules where employee_id = uid),
    (select permissions_per_month from public.ta_settings where id = true), 3);
  v_used  := public.ta_permission_used(uid, v_month);
  v_auto  := v_used < v_limit;

  insert into public.ta_leave_permissions (
    employee_id, permission_date, start_time, end_time, duration_minutes, reason,
    status, approval_type, requires_approval, used_before, monthly_limit,
    decided_at, decided_by)
  values (
    uid, p_date, p_start, p_end, v_mins, nullif(btrim(coalesce(p_reason, '')), ''),
    case when v_auto then 'approved'::ta_permission_status else 'pending'::ta_permission_status end,
    case when v_auto then 'automatic'::ta_permission_approval else null end,
    not v_auto, v_used, v_limit,
    case when v_auto then now() end,
    null)
  returning * into rec;

  select full_name into v_name from public.ta_profiles where id = uid;

  if v_auto then
    insert into public.ta_notifications (employee_id, title, message, type)
    values (uid, 'Leave Permission Approved',
      format('Your permission on %s (%s–%s, %s min) was approved automatically. You have used %s of %s this month.',
             to_char(p_date, 'Mon DD'), to_char(p_start, 'HH24:MI'), to_char(p_end, 'HH24:MI'),
             v_mins, v_used + 1, v_limit),
      'permission_approved');
  else
    insert into public.ta_notifications (employee_id, title, message, type)
    values (uid, 'Leave Permission Pending',
      format('You have already used all %s permissions this month, so your request on %s (%s–%s) needs admin approval.',
             v_limit, to_char(p_date, 'Mon DD'), to_char(p_start, 'HH24:MI'), to_char(p_end, 'HH24:MI')),
      'permission_pending');

    insert into public.ta_notifications (employee_id, title, message, type)
    select a.id, 'Leave Permission Needs Approval',
           format('%s requested a leave permission on %s (%s–%s, %s min) beyond their %s per month.',
                  coalesce(v_name, 'An employee'), to_char(p_date, 'Mon DD'),
                  to_char(p_start, 'HH24:MI'), to_char(p_end, 'HH24:MI'), v_mins, v_limit),
           'permission_pending'
      from public.ta_profiles a
     where a.role = 'admin' and a.id <> uid;
  end if;

  return rec;
end $$;

-- ── ADMIN DECISION ──────────────────────────────────────────────────────────
create or replace function public.ta_review_permission(
  p_id uuid, p_decision text, p_note text default null)
returns public.ta_leave_permissions language plpgsql security definer set search_path = public as $$
declare rec public.ta_leave_permissions;
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can decide leave permissions.' using errcode = 'P0001';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'A decision is either approved or rejected.' using errcode = 'P0001';
  end if;

  select * into rec from public.ta_leave_permissions where id = p_id for update;
  if not found then
    raise exception 'That leave permission no longer exists.' using errcode = 'P0001';
  end if;
  if rec.status <> 'pending' then
    raise exception 'That leave permission was already %.', rec.status using errcode = 'P0001';
  end if;

  update public.ta_leave_permissions
     set status        = p_decision::ta_permission_status,
         approval_type = 'admin',
         decided_at    = now(),
         decided_by    = auth.uid(),
         admin_note    = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_id
   returning * into rec;

  insert into public.ta_notifications (employee_id, title, message, type)
  values (rec.employee_id,
    case when p_decision = 'approved' then 'Leave Permission Approved' else 'Leave Permission Rejected' end,
    format('Your permission on %s (%s–%s, %s min) was %s by an admin.%s',
           to_char(rec.permission_date, 'Mon DD'), to_char(rec.start_time, 'HH24:MI'),
           to_char(rec.end_time, 'HH24:MI'), rec.duration_minutes, p_decision,
           case when rec.admin_note is null then '' else ' Note: ' || rec.admin_note end),
    case when p_decision = 'approved' then 'permission_approved' else 'permission_rejected' end);

  return rec;
end $$;

-- ── CANCEL ──────────────────────────────────────────────────────────────────
--  An employee may withdraw their own request while it is still in the future;
--  an admin may cancel any. Cancelling returns the allowance, which is why
--  ta_permission_used() counts only 'approved'.
create or replace function public.ta_cancel_permission(p_id uuid)
returns public.ta_leave_permissions language plpgsql security definer set search_path = public as $$
declare rec public.ta_leave_permissions; v_admin boolean := public.ta_is_admin();
begin
  select * into rec from public.ta_leave_permissions where id = p_id for update;
  if not found then
    raise exception 'That leave permission no longer exists.' using errcode = 'P0001';
  end if;
  if rec.employee_id <> auth.uid() and not v_admin then
    raise exception 'You can only cancel your own leave permissions.' using errcode = 'P0001';
  end if;
  if rec.status in ('rejected', 'cancelled') then
    raise exception 'That leave permission is already %.', rec.status using errcode = 'P0001';
  end if;
  if not v_admin and rec.permission_date < public.ta_today_local() then
    raise exception 'That day has already passed — ask an admin to cancel it.' using errcode = 'P0001';
  end if;

  update public.ta_leave_permissions
     set status = 'cancelled', decided_at = now(), decided_by = auth.uid()
   where id = p_id
   returning * into rec;

  if v_admin and rec.employee_id <> auth.uid() then
    insert into public.ta_notifications (employee_id, title, message, type)
    values (rec.employee_id, 'Leave Permission Cancelled',
      format('Your permission on %s (%s–%s) was cancelled by an admin.',
             to_char(rec.permission_date, 'Mon DD'), to_char(rec.start_time, 'HH24:MI'),
             to_char(rec.end_time, 'HH24:MI')),
      'permission_rejected');
  end if;

  return rec;
end $$;

-- ============================================================================
--  THE PAYROLL CALCULATION
--  ---------------------------------------------------------------------------
--  Pure derivation. Reads attendance, leave, permissions, rest days, off days
--  and holidays; writes nothing. Call it as often as you like.
--
--  Day classification, in priority order:
--    1. attendance row exists           → present (or late, past the grace)
--    2. company holiday                 → holiday
--    3. employee's weekly day off       → weekly_off
--    4. APPROVED vacation/leave request → leave
--    5. APPROVED rest day               → rest_day
--    6. APPROVED permission covering the WHOLE scheduled shift → permission
--    7. later than today (local)        → upcoming
--    8. otherwise                       → absent
--
--  Only case 8 costs absence money, and only case 1 can cost lateness money —
--  and then only on a day that was actually scheduled. Approved permissions
--  cost nothing at all unless the employee's own rules switch it on.
-- ============================================================================
create or replace function public.ta_payroll(p_employee uuid, p_year integer, p_month integer)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  cfg           public.ta_settings;
  tz            text;
  prof          public.ta_profiles;
  r             public.ta_salary_rules;
  sh            public.ta_shifts;
  att           public.ta_attendance;

  v_start       date;
  v_end         date;
  v_today       date;
  v_counted     date;
  v_shift_start time;
  v_shift_end   time;
  v_shift_name  text;
  v_off         integer[];

  -- The EFFECTIVE rules. Held as scalars rather than read off `r` directly, so
  -- an employee whose rules row does not exist yet (a brand-new profile,
  -- between the provisioning trigger and the first admin edit) falls back to
  -- the company defaults with no special-casing further down.
  v_salary      numeric(12,2);
  v_shift_id    uuid;
  v_grace       integer;
  v_late_rate   numeric(10,2);
  v_late_cap    numeric(12,2);
  v_abs_basis   text;
  v_abs_fixed   integer;
  v_abs_mult    numeric(6,3);
  v_active      boolean;
  v_perm_limit  integer;
  v_perm_on     boolean;
  v_perm_mode   text;
  v_perm_rate   numeric(10,2);

  d             date;
  v_dow         integer;
  v_holiday     text;
  v_is_off      boolean;
  v_on_leave    boolean;
  v_leave_type  text;
  v_on_rest     boolean;
  v_perm_cnt    integer;
  v_perm_min    integer;
  v_perm_all    boolean;
  v_perm_ded    numeric(12,2);
  v_local       timestamp;
  v_sched       timestamp;
  v_late        integer;
  v_bill        integer;
  v_day_ded     numeric(12,2);
  v_type        text;

  t_scheduled   integer := 0;
  t_present     integer := 0;
  t_on_time     integer := 0;
  t_late_days   integer := 0;
  t_late_bill   integer := 0;
  t_late_raw    integer := 0;
  t_late_ded    numeric(12,2) := 0;
  t_absent      integer := 0;
  t_leave       integer := 0;
  t_rest        integer := 0;
  t_off         integer := 0;
  t_holiday     integer := 0;
  t_perm_days   integer := 0;
  t_perm_cnt    integer := 0;
  t_perm_min    integer := 0;
  t_perm_ded    numeric(12,2) := 0;
  t_worked_min  bigint := 0;

  v_base        numeric(12,2);
  v_daily       numeric(12,2);
  v_absent_ded  numeric(12,2);
  v_other       numeric(12,2) := 0;
  v_total_ded   numeric(12,2);
  v_days        jsonb := '[]'::jsonb;
  v_adj         jsonb := '[]'::jsonb;
  v_perms       jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'You are not signed in.' using errcode = 'P0001';
  end if;
  -- An employee may ask for their OWN payroll and nobody else's.
  if p_employee is distinct from auth.uid() and not public.ta_is_admin() then
    raise exception 'You can only view your own payroll.' using errcode = 'P0001';
  end if;
  if p_month < 1 or p_month > 12 or p_year < 2000 or p_year > 2999 then
    raise exception 'Invalid payroll period.' using errcode = 'P0001';
  end if;

  select * into prof from public.ta_profiles where id = p_employee;
  if not found then
    raise exception 'No such employee.' using errcode = 'P0001';
  end if;

  cfg := public.ta_cfg();
  tz  := coalesce(cfg.timezone, 'Africa/Cairo');

  v_start   := make_date(p_year, p_month, 1);
  v_end     := (v_start + interval '1 month - 1 day')::date;
  v_today   := (now() at time zone tz)::date;
  -- Nothing in the future counts as anything yet.
  v_counted := least(v_end, v_today);

  -- ── Rules ─────────────────────────────────────────────────────────────────
  --  A missing row leaves every field NULL, so the coalesces below quietly
  --  produce the company defaults instead of a crash or a zero salary.
  select * into r from public.ta_salary_rules where employee_id = p_employee;

  v_salary     := coalesce(r.monthly_salary, cfg.default_salary, 6000);
  v_shift_id   := coalesce(r.shift_id, (select id from public.ta_shifts where code = 'shift_2'));
  v_grace      := coalesce(r.grace_minutes, cfg.default_grace_minutes, 15);
  v_late_rate  := coalesce(r.late_deduction_per_minute, cfg.default_late_per_minute, 1);
  v_late_cap   := r.late_deduction_cap_per_day;          -- NULL = no cap
  v_abs_basis  := coalesce(r.absence_basis, 'scheduled');
  v_abs_fixed  := coalesce(r.absence_fixed_days, 26);
  v_abs_mult   := coalesce(r.absence_multiplier, 1);
  v_active     := coalesce(r.is_active, true);
  v_perm_limit := coalesce(r.permissions_per_month, cfg.permissions_per_month, 3);
  v_perm_on    := coalesce(r.permission_deduction_enabled, false);
  v_perm_mode  := coalesce(r.permission_deduction_mode, 'per_minute');
  v_perm_rate  := coalesce(r.permission_deduction_rate, 0);

  select * into sh from public.ta_shifts where id = v_shift_id;
  v_shift_start := coalesce(r.shift_start_override, sh.start_time, time '10:00');
  v_shift_end   := coalesce(r.shift_end_override,   sh.end_time,   time '18:00');
  v_shift_name  := coalesce(sh.name, 'Custom hours');

  select coalesce(array_agg(day_of_week order by day_of_week), '{}'::integer[])
    into v_off from public.ta_weekly_off_days where employee_id = p_employee;

  -- ── Scheduled working days in the WHOLE month — the divisor for the daily
  --    rate. Counted over the full month, not just the elapsed part, so the
  --    rate doesn't drift upward as the month goes on. ─────────────────────
  select count(*)::int into t_scheduled
    from generate_series(v_start::timestamp, v_end::timestamp, interval '1 day') g(ts)
   where extract(dow from g.ts)::int <> all (v_off)
     and not exists (select 1 from public.ta_holidays h where h.holiday_date = g.ts::date);

  v_base := v_salary;
  if v_abs_basis = 'fixed_days' then
    v_daily := round(v_base / greatest(v_abs_fixed, 1), 2);
  else
    v_daily := case when t_scheduled > 0 then round(v_base / t_scheduled, 2) else 0 end;
  end if;

  -- ── Walk the month ────────────────────────────────────────────────────────
  for d in select g.ts::date
             from generate_series(v_start::timestamp, v_end::timestamp, interval '1 day') g(ts)
  loop
    v_dow      := extract(dow from d)::int;
    v_holiday  := (select h.name from public.ta_holidays h where h.holiday_date = d);
    v_is_off   := v_dow = any (v_off);
    v_leave_type := null;
    v_late := 0; v_bill := 0; v_day_ded := 0; v_perm_ded := 0;

    select lr.leave_type::text into v_leave_type
      from public.ta_leave_requests lr
     where lr.employee_id = p_employee
       and lr.status = 'approved'
       and d between lr.start_date and lr.end_date
     limit 1;
    v_on_leave := v_leave_type is not null;

    v_on_rest := exists (
      select 1 from public.ta_rest_day_requests rd
       where rd.employee_id = p_employee and rd.status = 'approved' and d = any (rd.dates));

    -- Approved permissions on this day.
    select count(*)::int, coalesce(sum(lp.duration_minutes), 0)::int,
           coalesce(bool_or(lp.start_time <= v_shift_start and lp.end_time >= v_shift_end), false)
      into v_perm_cnt, v_perm_min, v_perm_all
      from public.ta_leave_permissions lp
     where lp.employee_id = p_employee and lp.permission_date = d and lp.status = 'approved';

    if v_perm_cnt > 0 then
      t_perm_cnt := t_perm_cnt + v_perm_cnt;
      t_perm_min := t_perm_min + v_perm_min;
      -- OFF by default. Only an admin switching it on for this employee turns
      -- an approved permission into money.
      if v_perm_on then
        if v_perm_mode = 'per_minute' then
          v_perm_ded := round(v_perm_min * v_perm_rate, 2);
        elsif v_perm_mode = 'per_occurrence' then
          v_perm_ded := round(v_perm_cnt * v_perm_rate, 2);
        end if;   -- 'fixed' is a once-a-month charge, added after the loop
        t_perm_ded := t_perm_ded + v_perm_ded;
      end if;
    end if;

    select * into att from public.ta_attendance
     where employee_id = p_employee and work_date = d;

    if found and att.clock_in is not null then
      v_type    := 'present';
      t_present := t_present + 1;
      t_worked_min := t_worked_min + coalesce(att.total_minutes, 0);

      -- Lateness only applies to a day the employee was actually scheduled to
      -- work. Turning up on a day off is never penalised.
      if not v_is_off and v_holiday is null then
        v_local := att.clock_in at time zone tz;
        v_sched := d + v_shift_start;
        v_late  := greatest(0, floor(extract(epoch from (v_local - v_sched)) / 60))::int;
        v_bill  := greatest(0, v_late - v_grace);
        if v_bill > 0 then
          v_type      := 'late';
          v_day_ded   := least(round(v_bill * v_late_rate, 2),
                               v_late_cap);
          t_late_days := t_late_days + 1;
          t_late_bill := t_late_bill + v_bill;
          t_late_raw  := t_late_raw + v_late;
          t_late_ded  := t_late_ded + v_day_ded;
        else
          t_on_time := t_on_time + 1;
        end if;
      else
        t_on_time := t_on_time + 1;
      end if;

    elsif v_holiday is not null then
      v_type := 'holiday';  t_holiday := t_holiday + 1;
    elsif v_is_off then
      v_type := 'weekly_off'; t_off := t_off + 1;
    elsif v_on_leave then
      v_type := 'leave';      t_leave := t_leave + 1;
    elsif v_on_rest then
      v_type := 'rest_day';   t_rest := t_rest + 1;
    elsif v_perm_all then
      -- An approved permission that spans the entire shift excuses the day —
      -- it is authorised absence, not an unexplained one.
      v_type := 'permission'; t_perm_days := t_perm_days + 1;
    elsif d > v_counted then
      v_type := 'upcoming';
    else
      v_type := 'absent';
      t_absent := t_absent + 1;
      v_day_ded := round(v_daily * v_abs_mult, 2);
    end if;

    v_days := v_days || jsonb_build_object(
      'date',                 to_char(d, 'YYYY-MM-DD'),
      'dow',                  v_dow,
      'type',                 v_type,
      'holiday',              v_holiday,
      'leave_type',           v_leave_type,
      'clock_in',             att.clock_in,
      'clock_out',            att.clock_out,
      'clock_in_local',       case when att.clock_in is not null
                                then to_char(att.clock_in at time zone tz, 'HH24:MI') end,
      'clock_out_local',      case when att.clock_out is not null
                                then to_char(att.clock_out at time zone tz, 'HH24:MI') end,
      'worked_minutes',       coalesce(att.total_minutes, 0),
      'late_minutes',         v_late,
      'billable_minutes',     v_bill,
      'permission_count',     v_perm_cnt,
      'permission_minutes',   v_perm_min,
      'permission_deduction', v_perm_ded,
      'deduction',            v_day_ded);
  end loop;

  -- ── Money ─────────────────────────────────────────────────────────────────
  v_absent_ded := round(t_absent * v_daily * v_abs_mult, 2);

  -- 'fixed' means one flat charge for the month, however many permissions.
  if v_perm_on
     and v_perm_mode = 'fixed' and t_perm_cnt > 0 then
    t_perm_ded := v_perm_rate;
  end if;

  select coalesce(sum(a.amount), 0),
         coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'label', a.label, 'amount', a.amount,
           'note', a.note, 'created_at', a.created_at) order by a.created_at), '[]'::jsonb)
    into v_other, v_adj
    from public.ta_payroll_adjustments a
   where a.employee_id = p_employee and a.period_month = v_start;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', lp.id,
           'permission_date', to_char(lp.permission_date, 'YYYY-MM-DD'),
           'start_time', to_char(lp.start_time, 'HH24:MI'),
           'end_time', to_char(lp.end_time, 'HH24:MI'),
           'duration_minutes', lp.duration_minutes,
           'status', lp.status,
           'approval_type', lp.approval_type,
           'reason', lp.reason) order by lp.permission_date, lp.start_time), '[]'::jsonb)
    into v_perms
    from public.ta_leave_permissions lp
   where lp.employee_id = p_employee
     and lp.permission_date between v_start and v_end
     and lp.status = 'approved';

  v_total_ded := round(t_late_ded + v_absent_ded + t_perm_ded + v_other, 2);

  return jsonb_build_object(
    'employee', jsonb_build_object(
      'id', prof.id, 'full_name', prof.full_name, 'email', prof.email,
      'department', prof.department, 'position', prof.position,
      'avatar_url', prof.avatar_url, 'role', prof.role),
    'period', jsonb_build_object(
      'year', p_year, 'month', p_month,
      'start', to_char(v_start, 'YYYY-MM-DD'),
      'end',   to_char(v_end,   'YYYY-MM-DD'),
      'counted_to', to_char(v_counted, 'YYYY-MM-DD'),
      'is_current', (v_today between v_start and v_end),
      'timezone', tz),
    'rules', jsonb_build_object(
      'monthly_salary', v_salary,
      'shift_id', v_shift_id,
      'shift_name', v_shift_name,
      'shift_start', to_char(v_shift_start, 'HH24:MI'),
      'shift_end',   to_char(v_shift_end,   'HH24:MI'),
      'grace_minutes', v_grace,
      'late_deduction_per_minute', v_late_rate,
      'late_deduction_cap_per_day', v_late_cap,
      'absence_basis', v_abs_basis,
      'absence_fixed_days', v_abs_fixed,
      'absence_multiplier', v_abs_mult,
      'permissions_per_month', v_perm_limit,
      'permission_deduction_enabled', v_perm_on,
      'permission_deduction_mode', v_perm_mode,
      'permission_deduction_rate', v_perm_rate,
      'is_active', v_active,
      'off_days', to_jsonb(v_off),
      'daily_rate', v_daily),
    'totals', jsonb_build_object(
      'base_salary', v_base,
      'working_days', t_scheduled,
      'days_present', t_present,
      'on_time_days', t_on_time,
      'late_days', t_late_days,
      'total_late_minutes', t_late_bill,
      'raw_late_minutes', t_late_raw,
      'late_deduction', t_late_ded,
      'absence_days', t_absent,
      'absence_deduction', v_absent_ded,
      'daily_rate', v_daily,
      'leave_days', t_leave,
      'rest_days', t_rest,
      'off_days', t_off,
      'holidays', t_holiday,
      'permission_count', t_perm_cnt,
      'permission_minutes', t_perm_min,
      'permission_days', t_perm_days,
      'permission_deduction', t_perm_ded,
      'worked_minutes', t_worked_min,
      'other_deductions', v_other,
      'total_deductions', v_total_ded,
      'net_salary', round(v_base - v_total_ded, 2)),
    'adjustments', v_adj,
    'permissions', v_perms,
    'days', v_days);
end $$;

-- Every employee's month in one round trip, without the per-day detail.
-- Admin only.
create or replace function public.ta_payroll_all(
  p_year integer, p_month integer, p_include_inactive boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can view company payroll.' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(public.ta_payroll(p.id, p_year, p_month) - 'days'::text
                            order by p.full_name), '[]'::jsonb)
    into res
    from public.ta_profiles p
    left join public.ta_salary_rules s on s.employee_id = p.id
   where p_include_inactive or coalesce(s.is_active, true);
  return res;
end $$;

-- ============================================================================
--  ADMIN WRITE RPCs — the ONLY way salary/schedule data ever changes
-- ============================================================================

-- ── Per-employee rules, including the weekly days off ───────────────────────
--  Off days are written into the existing ta_weekly_off_days table so the
--  calendar, the rest-day picker and the weekend-change flow all keep seeing
--  the same schedule they always have. Pass NULL for p_off_days to leave the
--  current schedule untouched.
create or replace function public.ta_set_salary_rules(
  p_employee            uuid,
  p_monthly_salary      numeric   default null,
  p_shift               uuid      default null,
  p_grace               integer   default null,
  p_late_per_minute     numeric   default null,
  p_absence_basis       text      default null,
  p_absence_fixed_days  integer   default null,
  p_absence_multiplier  numeric   default null,
  p_off_days            integer[] default null,
  p_is_active           boolean   default null,
  p_shift_start         time      default null,
  p_shift_end           time      default null,
  p_late_cap            numeric   default null,
  p_clear_overrides     boolean   default false,
  p_note                text      default null,
  p_permissions_per_month integer default null,
  p_permission_deduction_enabled boolean default null,
  p_permission_deduction_mode    text    default null,
  p_permission_deduction_rate    numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r      public.ta_salary_rules;
  before public.ta_salary_rules;
  v_off  integer[];
  v_msg  text := '';
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can change salary and attendance rules.' using errcode = 'P0001';
  end if;
  if p_employee is null or not exists (select 1 from public.ta_profiles where id = p_employee) then
    raise exception 'No such employee.' using errcode = 'P0001';
  end if;
  if p_monthly_salary is not null and p_monthly_salary < 0 then
    raise exception 'A salary cannot be negative.' using errcode = 'P0001';
  end if;
  if p_grace is not null and (p_grace < 0 or p_grace > 240) then
    raise exception 'The grace period must be between 0 and 240 minutes.' using errcode = 'P0001';
  end if;
  if p_late_per_minute is not null and p_late_per_minute < 0 then
    raise exception 'The late deduction cannot be negative.' using errcode = 'P0001';
  end if;
  if p_absence_basis is not null and p_absence_basis not in ('scheduled','fixed_days') then
    raise exception 'Unknown absence rule.' using errcode = 'P0001';
  end if;
  if p_absence_fixed_days is not null and (p_absence_fixed_days < 1 or p_absence_fixed_days > 31) then
    raise exception 'The fixed month length must be between 1 and 31 days.' using errcode = 'P0001';
  end if;
  if p_absence_multiplier is not null and p_absence_multiplier < 0 then
    raise exception 'The absence multiplier cannot be negative.' using errcode = 'P0001';
  end if;
  if p_shift is not null and not exists (select 1 from public.ta_shifts where id = p_shift) then
    raise exception 'Unknown work shift.' using errcode = 'P0001';
  end if;
  if p_permissions_per_month is not null
     and (p_permissions_per_month < 0 or p_permissions_per_month > 31) then
    raise exception 'The monthly permission allowance must be between 0 and 31.' using errcode = 'P0001';
  end if;
  if p_permission_deduction_mode is not null
     and p_permission_deduction_mode not in ('per_minute','per_occurrence','fixed') then
    raise exception 'Unknown permission deduction method.' using errcode = 'P0001';
  end if;
  if p_permission_deduction_rate is not null and p_permission_deduction_rate < 0 then
    raise exception 'The permission deduction cannot be negative.' using errcode = 'P0001';
  end if;
  if p_off_days is not null then
    if exists (select 1 from unnest(p_off_days) d where d < 0 or d > 6) then
      raise exception 'A weekly day off must be between 0 (Sunday) and 6 (Saturday).' using errcode = 'P0001';
    end if;
    if array_length(p_off_days, 1) > 6 then
      raise exception 'An employee must have at least one working day.' using errcode = 'P0001';
    end if;
  end if;

  before := public.ta_ensure_salary_rules(p_employee);

  update public.ta_salary_rules set
    monthly_salary             = coalesce(p_monthly_salary,     monthly_salary),
    shift_id                   = coalesce(p_shift,              shift_id),
    grace_minutes              = coalesce(p_grace,              grace_minutes),
    late_deduction_per_minute  = coalesce(p_late_per_minute,    late_deduction_per_minute),
    absence_basis              = coalesce(p_absence_basis,      absence_basis),
    absence_fixed_days         = coalesce(p_absence_fixed_days, absence_fixed_days),
    absence_multiplier         = coalesce(p_absence_multiplier, absence_multiplier),
    is_active                  = coalesce(p_is_active,          is_active),
    permissions_per_month        = coalesce(p_permissions_per_month,        permissions_per_month),
    permission_deduction_enabled = coalesce(p_permission_deduction_enabled, permission_deduction_enabled),
    permission_deduction_mode    = coalesce(p_permission_deduction_mode,    permission_deduction_mode),
    permission_deduction_rate    = coalesce(p_permission_deduction_rate,    permission_deduction_rate),
    -- p_clear_overrides wins, so "back to the shift's own hours" is expressible.
    shift_start_override       = case when p_clear_overrides then null
                                      else coalesce(p_shift_start, shift_start_override) end,
    shift_end_override         = case when p_clear_overrides then null
                                      else coalesce(p_shift_end, shift_end_override) end,
    late_deduction_cap_per_day = case when p_clear_overrides then null
                                      else coalesce(p_late_cap, late_deduction_cap_per_day) end,
    note                       = coalesce(p_note, note),
    updated_by                 = auth.uid(),
    updated_at                 = now()
  where employee_id = p_employee
  returning * into r;

  if p_off_days is not null then
    delete from public.ta_weekly_off_days where employee_id = p_employee;
    insert into public.ta_weekly_off_days (employee_id, day_of_week)
    select p_employee, d from unnest(p_off_days) d
    on conflict (employee_id, day_of_week) do nothing;
  end if;

  select coalesce(array_agg(day_of_week order by day_of_week), '{}'::integer[])
    into v_off from public.ta_weekly_off_days where employee_id = p_employee;

  -- Tell the employee, the way every other privileged change in this app does.
  if before.monthly_salary is distinct from r.monthly_salary then
    v_msg := v_msg || 'Monthly salary updated. ';
  end if;
  if before.shift_id is distinct from r.shift_id
     or before.shift_start_override is distinct from r.shift_start_override then
    v_msg := v_msg || 'Your work shift changed. ';
  end if;
  if p_off_days is not null then
    v_msg := v_msg || 'Weekly days off: ' || public.ta_days_label(v_off::smallint[]) || '. ';
  end if;
  if before.grace_minutes is distinct from r.grace_minutes
     or before.late_deduction_per_minute is distinct from r.late_deduction_per_minute then
    v_msg := v_msg || 'Lateness rules updated. ';
  end if;
  if before.permissions_per_month is distinct from r.permissions_per_month
     or before.permission_deduction_enabled is distinct from r.permission_deduction_enabled then
    v_msg := v_msg || 'Leave-permission rules updated. ';
  end if;
  if v_msg <> '' then
    insert into public.ta_notifications (employee_id, title, message, type)
    values (p_employee, 'Work rules updated', btrim(v_msg), 'info');
  end if;

  return jsonb_build_object('rules', to_jsonb(r), 'off_days', to_jsonb(v_off));
end $$;

-- ── Edit a shift's hours / name ─────────────────────────────────────────────
create or replace function public.ta_set_shift(
  p_shift uuid,
  p_name  text default null,
  p_start time default null,
  p_end   time default null,
  p_active boolean default null)
returns public.ta_shifts language plpgsql security definer set search_path = public as $$
declare s public.ta_shifts;
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can change work shifts.' using errcode = 'P0001';
  end if;
  update public.ta_shifts set
    name       = coalesce(nullif(btrim(p_name), ''), name),
    start_time = coalesce(p_start, start_time),
    end_time   = coalesce(p_end,   end_time),
    is_active  = coalesce(p_active, is_active),
    updated_by = auth.uid(),
    updated_at = now()
  where id = p_shift
  returning * into s;
  if not found then
    raise exception 'Unknown work shift.' using errcode = 'P0001';
  end if;
  return s;
end $$;

-- ── Company payroll defaults (timezone + what new employees inherit) ────────
create or replace function public.ta_set_payroll_defaults(
  p_timezone        text    default null,
  p_salary          numeric default null,
  p_grace           integer default null,
  p_late_per_minute numeric default null,
  p_permissions     integer default null)
returns public.ta_settings language plpgsql security definer set search_path = public as $$
declare s public.ta_settings;
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can change payroll defaults.' using errcode = 'P0001';
  end if;
  if p_timezone is not null then
    -- Reject a typo before it silently skews every lateness calculation.
    begin
      perform now() at time zone p_timezone;
    exception when others then
      raise exception 'Unknown timezone: %', p_timezone using errcode = 'P0001';
    end;
  end if;
  update public.ta_settings set
    timezone                = coalesce(p_timezone, timezone),
    default_salary          = coalesce(p_salary, default_salary),
    default_grace_minutes   = coalesce(p_grace, default_grace_minutes),
    default_late_per_minute = coalesce(p_late_per_minute, default_late_per_minute),
    permissions_per_month   = coalesce(p_permissions, permissions_per_month),
    updated_by              = auth.uid(),
    updated_at              = now()
  where id = true
  returning * into s;
  return s;
end $$;

-- ── Manual "other deduction" — idempotent by (employee, month, label) ───────
create or replace function public.ta_set_payroll_adjustment(
  p_employee uuid, p_year integer, p_month integer,
  p_label text, p_amount numeric, p_note text default null)
returns public.ta_payroll_adjustments language plpgsql security definer set search_path = public as $$
declare a public.ta_payroll_adjustments; v_period date;
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can record payroll deductions.' using errcode = 'P0001';
  end if;
  if p_month < 1 or p_month > 12 then
    raise exception 'Invalid payroll period.' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_label), '') = '' then
    raise exception 'Give the deduction a name.' using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'A deduction cannot be negative.' using errcode = 'P0001';
  end if;
  v_period := make_date(p_year, p_month, 1);

  insert into public.ta_payroll_adjustments (employee_id, period_month, label, amount, note, created_by)
  values (p_employee, v_period, btrim(p_label), p_amount, p_note, auth.uid())
  on conflict (employee_id, period_month, lower(btrim(label))) do update
     set amount = excluded.amount, note = excluded.note,
         created_by = excluded.created_by, created_at = now()
  returning * into a;
  return a;
end $$;

create or replace function public.ta_delete_payroll_adjustment(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can remove payroll deductions.' using errcode = 'P0001';
  end if;
  delete from public.ta_payroll_adjustments where id = p_id;
  return found;
end $$;

-- ── Holidays ────────────────────────────────────────────────────────────────
create or replace function public.ta_set_holiday(p_date date, p_name text default 'Holiday')
returns public.ta_holidays language plpgsql security definer set search_path = public as $$
declare h public.ta_holidays;
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can change the holiday calendar.' using errcode = 'P0001';
  end if;
  if p_date is null then
    raise exception 'Pick a date.' using errcode = 'P0001';
  end if;
  insert into public.ta_holidays (holiday_date, name, created_by)
  values (p_date, coalesce(nullif(btrim(p_name), ''), 'Holiday'), auth.uid())
  on conflict (holiday_date) do update set name = excluded.name
  returning * into h;
  return h;
end $$;

create or replace function public.ta_delete_holiday(p_date date)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can change the holiday calendar.' using errcode = 'P0001';
  end if;
  delete from public.ta_holidays where holiday_date = p_date;
  return found;
end $$;

-- ============================================================================
--  PROVISIONING — every profile gets a rules row
-- ============================================================================
create or replace function public.ta_handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.ta_profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data->>'role')::ta_role, 'employee')
  )
  on conflict (id) do nothing;

  insert into public.ta_leave_balances (employee_id, leave_type, total_days) values
    (new.id, 'casual', 12), (new.id, 'medical', 8), (new.id, 'planned', 5)
  on conflict (employee_id, leave_type) do nothing;

  insert into public.ta_rest_balances (employee_id, total_days)
  values (new.id, coalesce((select rest_days_default from public.ta_settings where id = true), 4))
  on conflict (employee_id) do nothing;

  -- v7: salary rules + the role's default weekly days off.
  perform public.ta_ensure_salary_rules(new.id);

  return new;
end $$;

-- Backfill everyone who already exists. ta_ensure_salary_rules() only seeds
-- days off for people who have none, so an admin's existing schedule survives.
do $$
declare p record;
begin
  for p in select id from public.ta_profiles loop
    perform public.ta_ensure_salary_rules(p.id);
  end loop;
end $$;

-- ============================================================================
--  ROW LEVEL SECURITY
-- ============================================================================
alter table public.ta_shifts              enable row level security;
alter table public.ta_holidays            enable row level security;
alter table public.ta_salary_rules        enable row level security;
alter table public.ta_payroll_adjustments enable row level security;
alter table public.ta_leave_permissions   enable row level security;

-- Shifts and holidays are company-wide reference data — everyone reads them
-- (the employee schedule card names their shift), nobody writes them over the
-- API.
drop policy if exists ta_shift_sel on public.ta_shifts;
create policy ta_shift_sel on public.ta_shifts for select to authenticated using (true);

drop policy if exists ta_hol_sel on public.ta_holidays;
create policy ta_hol_sel on public.ta_holidays for select to authenticated using (true);

-- Salary rules: your own, or everything if you are an admin. A manager gets
-- NOTHING here — approving leave never requires seeing a colleague's pay.
drop policy if exists ta_salrules_sel on public.ta_salary_rules;
create policy ta_salrules_sel on public.ta_salary_rules for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin());

drop policy if exists ta_payadj_sel on public.ta_payroll_adjustments;
create policy ta_payadj_sel on public.ta_payroll_adjustments for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin());

-- Leave permissions: an employee sees their own history, an admin sees all.
drop policy if exists ta_perm_sel on public.ta_leave_permissions;
create policy ta_perm_sel on public.ta_leave_permissions for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin());

-- No INSERT/UPDATE/DELETE policy is created for any of these tables. With RLS
-- on and no policy, those commands are denied to every authenticated user,
-- admins included — the RPCs above are the only route. In particular, an
-- employee cannot INSERT a permission row with status 'approved', because they
-- cannot INSERT one at all.
drop policy if exists ta_salrules_upd on public.ta_salary_rules;
drop policy if exists ta_salrules_ins on public.ta_salary_rules;
drop policy if exists ta_payadj_upd   on public.ta_payroll_adjustments;
drop policy if exists ta_payadj_ins   on public.ta_payroll_adjustments;
drop policy if exists ta_perm_ins     on public.ta_leave_permissions;
drop policy if exists ta_perm_upd     on public.ta_leave_permissions;

-- ============================================================================
--  GRANTS
-- ============================================================================
grant select on
  public.ta_shifts, public.ta_holidays, public.ta_salary_rules,
  public.ta_payroll_adjustments, public.ta_leave_permissions
to authenticated;

-- Belt and braces: refuse the write with 42501 before RLS is consulted.
revoke insert, update, delete on public.ta_shifts              from authenticated;
revoke insert, update, delete on public.ta_holidays            from authenticated;
revoke insert, update, delete on public.ta_salary_rules        from authenticated;
revoke insert, update, delete on public.ta_payroll_adjustments from authenticated;
revoke insert, update, delete on public.ta_leave_permissions   from authenticated;

grant execute on function public.ta_now_local()                             to authenticated;
grant execute on function public.ta_today_local()                           to authenticated;
grant execute on function public.ta_default_off_days(text, text)            to authenticated;
grant execute on function public.ta_permission_used(uuid, date)             to authenticated;
grant execute on function public.ta_permission_usage(uuid, integer, integer) to authenticated;
grant execute on function public.ta_request_permission(date, time, time, text) to authenticated;
grant execute on function public.ta_review_permission(uuid, text, text)     to authenticated;
grant execute on function public.ta_cancel_permission(uuid)                 to authenticated;
grant execute on function public.ta_payroll(uuid, integer, integer)         to authenticated;
grant execute on function public.ta_payroll_all(integer, integer, boolean)  to authenticated;
grant execute on function public.ta_set_salary_rules(
  uuid, numeric, uuid, integer, numeric, text, integer, numeric,
  integer[], boolean, time, time, numeric, boolean, text,
  integer, boolean, text, numeric)                                          to authenticated;
grant execute on function public.ta_set_shift(uuid, text, time, time, boolean) to authenticated;
grant execute on function public.ta_set_payroll_defaults(text, numeric, integer, numeric, integer) to authenticated;
grant execute on function public.ta_set_payroll_adjustment(uuid, integer, integer, text, numeric, text) to authenticated;
grant execute on function public.ta_delete_payroll_adjustment(uuid)         to authenticated;
grant execute on function public.ta_set_holiday(date, text)                 to authenticated;
grant execute on function public.ta_delete_holiday(date)                    to authenticated;

-- Internal only — the trigger and the admin RPCs call it as the function
-- owner. An employee must never be able to create their own rules row.
revoke execute on function public.ta_ensure_salary_rules(uuid) from public, anon, authenticated;

-- ============================================================================
--  REALTIME (optional)
-- ============================================================================
do $$ begin
  alter publication supabase_realtime add table public.ta_leave_permissions;
exception when duplicate_object then null; when others then null; end $$;

-- ============================================================================
--  DONE. Sanity checks — run these after the migration.
-- ----------------------------------------------------------------------------
--  a) The three shifts exist:
--       select code, name, start_time, end_time from public.ta_shifts order by sort_order;
--
--  b) Everyone has rules and a schedule (expect 0 rows):
--       select p.full_name
--         from public.ta_profiles p
--         left join public.ta_salary_rules s on s.employee_id = p.id
--        where s.employee_id is null;
--
--  c) Sales get one day off, everyone else two:
--       select p.full_name, p.position, public.ta_days_label(
--                (select array_agg(day_of_week)::smallint[] from public.ta_weekly_off_days w
--                  where w.employee_id = p.id)) as days_off
--         from public.ta_profiles p order by p.full_name;
--
--  d) Salary rules and permissions are read-only over the API (all FALSE):
--       select has_table_privilege('authenticated','public.ta_salary_rules','UPDATE')      as rules_upd,
--              has_table_privilege('authenticated','public.ta_salary_rules','INSERT')      as rules_ins,
--              has_table_privilege('authenticated','public.ta_leave_permissions','INSERT') as perm_ins,
--              has_table_privilege('authenticated','public.ta_leave_permissions','UPDATE') as perm_upd;
--
--  e) A month of payroll for one person:
--       select public.ta_payroll(
--         (select id from public.ta_profiles order by full_name limit 1), 2026, 9);
--
--  f) The whole company (admin session required):
--       select public.ta_payroll_all(2026, 9);
--
--  g) This month's permission counter for everyone:
--       select p.full_name,
--              public.ta_permission_used(p.id, date_trunc('month', current_date)::date) as used,
--              coalesce(s.permissions_per_month, 3) as allowed
--         from public.ta_profiles p
--         left join public.ta_salary_rules s on s.employee_id = p.id
--        order by p.full_name;
-- ============================================================================
