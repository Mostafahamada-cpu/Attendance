-- ============================================================================
--  RingRoad — Attendance & Time-Off :: MIGRATION v8
--  TIERED LATE DEDUCTIONS · LATENESS HELPERS · EMPLOYEE BOARD
--  ---------------------------------------------------------------------------
--  Run AFTER schema-v7.sql. Idempotent — safe to re-run.
--
--  What this changes
--  ---------------------------------------------------------------------------
--   • ta_late_tiers          — THE late-deduction rule, in one table:
--                                 more than 15 min late → ¼ day
--                                 more than 30 min late → ½ day
--                                 more than 60 min late → 1 full day
--                              Editable by an admin (ta_set_late_tiers). Every
--                              screen that prices a late arrival reads it.
--   • ta_salary_rules.late_mode
--                            — 'tiered' (default, the rule above) or
--                              'per_minute' (the v7 grace + EGP/minute rule,
--                              kept for anyone who explicitly wants it).
--   • ta_late_deduction()    — the ONE function that turns "N minutes late"
--                              into money. ta_payroll() and the live-status
--                              helpers below all call it, so a late arrival is
--                              priced identically everywhere.
--   • ta_daily_rate()        — salary ÷ the employee's OWN scheduled days that
--                              month (their weekly off-days + holidays), shared
--                              by payroll and the lateness helpers.
--   • ta_lateness() / ta_attendance_lateness()
--                            — lateness for one clock-in / a date range, judged
--                              against each employee's own shift start in the
--                              company timezone. Replaces the hard-coded 09:15
--                              the analytics screen used to assume.
--   • ta_employee_board()    — one round trip for the admin's employee cards:
--                              rules, shift, off-days, today's status, the
--                              month so far, balances, pending leave.
--   • ta_payroll()           — re-created: tiered late deductions, per-day
--                              late label + day fraction, and "today" is no
--                              longer an absence until the shift has ended.
--
--  BOUNDARIES (exact minutes) — the chosen behaviour, applied everywhere
--  ---------------------------------------------------------------------------
--   Lateness is whole minutes, floored: a 10:15:59 arrival on a 10:00 shift is
--   15 minutes late. A tier applies when the employee is STRICTLY MORE than
--   its threshold late (`late_minutes > threshold_minutes`):
--       0 … 15 min  → on time / within grace, no deduction   (15 is free)
--      16 … 30 min  → ¼ day                                   (30 is ¼)
--      31 … 60 min  → ½ day                                   (60 is ½)
--      61+     min  → 1 full day
--   So each boundary minute belongs to the LOWER tier. The same comparison
--   lives in ta_late_tier(); nothing else decides a tier.
--
--  Lateness is measured against the employee's OWN effective start:
--   shift_start_override, else their assigned shift's start_time, else 10:00.
--   Nothing hard-codes a company-wide start time.
--
--  Salary editing: there is deliberately NO new salary table or RPC. The quick
--  "Edit salary" control in the app calls the existing ta_set_salary_rules()
--  with only p_monthly_salary set — the same admin check, the same bounds, the
--  same row that payroll reads.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. LATE TIERS — the rule, centralised
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ta_late_tiers (
  -- Applies when late_minutes is STRICTLY greater than this.
  threshold_minutes integer primary key check (threshold_minutes >= 0),
  -- Fraction of the daily rate deducted: 0.25 = quarter day, 1 = full day.
  deduction_days    numeric(6,3) not null check (deduction_days >= 0 and deduction_days <= 5),
  label             text not null check (length(btrim(label)) > 0),
  updated_by        uuid references public.ta_profiles(id),
  updated_at        timestamptz not null default now()
);

-- Seed the three company tiers. Stable keys, so re-running never duplicates
-- and never overwrites a tier an admin has since edited.
insert into public.ta_late_tiers (threshold_minutes, deduction_days, label) values
  (15, 0.25, 'Quarter day'),
  (30, 0.50, 'Half day'),
  (60, 1.00, 'Full day')
on conflict (threshold_minutes) do nothing;

-- Which rule an employee is priced with. Everyone moves to the tiers; the v7
-- per-minute rule stays available per person for anyone who explicitly wants it.
alter table public.ta_salary_rules
  add column if not exists late_mode text not null default 'tiered';
do $$ begin
  alter table public.ta_salary_rules add constraint ta_salrules_latemode_ck
    check (late_mode in ('tiered', 'per_minute'));
exception when duplicate_object then null; end $$;

-- The tier a number of late minutes falls into, or an all-NULL row when the
-- arrival is within the free window. THE boundary rule: strictly greater than.
create or replace function public.ta_late_tier(p_late_minutes integer)
returns public.ta_late_tiers language sql stable security definer set search_path = public as $$
  select * from public.ta_late_tiers
   where threshold_minutes < coalesce(p_late_minutes, 0)
   order by threshold_minutes desc
   limit 1;
$$;

-- The free window in tiered mode is the lowest threshold (15 by default).
create or replace function public.ta_late_grace()
returns integer language sql stable security definer set search_path = public as $$
  select coalesce((select min(threshold_minutes) from public.ta_late_tiers), 15);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE ONE PLACE LATE MINUTES BECOME MONEY
-- ─────────────────────────────────────────────────────────────────────────────
--  Returns { is_late, billable_minutes, deduction_days, amount, label,
--            tier_threshold, grace_minutes, mode }.
--  'tiered'     → ta_late_tiers × the employee's daily rate.
--  'per_minute' → the v7 rule: (late − grace) × rate, optionally capped.
create or replace function public.ta_late_deduction(
  p_late_minutes integer,
  p_mode         text,
  p_grace        integer,
  p_rate         numeric,
  p_cap          numeric,
  p_daily_rate   numeric)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  t       public.ta_late_tiers;
  v_late  integer := greatest(0, coalesce(p_late_minutes, 0));
  v_grace integer;
  v_bill  integer;
  v_amt   numeric(12,2);
begin
  if coalesce(p_mode, 'tiered') = 'tiered' then
    v_grace := public.ta_late_grace();
    t := public.ta_late_tier(v_late);
    if t.threshold_minutes is null then
      return jsonb_build_object(
        'is_late', false, 'billable_minutes', 0, 'deduction_days', 0, 'amount', 0,
        'label', case when v_late > 0 then 'Within grace' else 'On time' end,
        'tier_threshold', null, 'grace_minutes', v_grace, 'mode', 'tiered');
    end if;
    v_amt := round(coalesce(p_daily_rate, 0) * t.deduction_days, 2);
    return jsonb_build_object(
      'is_late', true, 'billable_minutes', greatest(0, v_late - v_grace),
      'deduction_days', t.deduction_days, 'amount', v_amt, 'label', t.label,
      'tier_threshold', t.threshold_minutes, 'grace_minutes', v_grace, 'mode', 'tiered');
  end if;

  -- Legacy per-minute rule (v7), unchanged.
  v_grace := coalesce(p_grace, 15);
  v_bill  := greatest(0, v_late - v_grace);
  -- least() ignores a NULL cap, so "no cap" needs no special case.
  v_amt   := least(round(v_bill * coalesce(p_rate, 0), 2), p_cap);
  return jsonb_build_object(
    'is_late', v_bill > 0, 'billable_minutes', v_bill, 'deduction_days', 0, 'amount', coalesce(v_amt, 0),
    'label', case when v_bill > 0 then v_bill || ' billable min' when v_late > 0 then 'Within grace' else 'On time' end,
    'tier_threshold', null, 'grace_minutes', v_grace, 'mode', 'per_minute');
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. DAILY RATE — the employee's OWN scheduled days, never a company weekend
-- ─────────────────────────────────────────────────────────────────────────────
--  { salary, working_days, daily_rate, basis, fixed_days, off_days }
--  working_days counts the WHOLE month minus this employee's weekly off-days
--  (ta_weekly_off_days) and company holidays, so two employees with different
--  rest days get different divisors from the same salary.
create or replace function public.ta_daily_rate(p_employee uuid, p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  cfg      public.ta_settings := public.ta_cfg();
  r        public.ta_salary_rules;
  v_start  date := date_trunc('month', p_month)::date;
  v_end    date;
  v_off    integer[];
  v_days   integer;
  v_salary numeric(12,2);
  v_basis  text;
  v_fixed  integer;
  v_daily  numeric(12,2);
begin
  v_end := (v_start + interval '1 month - 1 day')::date;
  select * into r from public.ta_salary_rules where employee_id = p_employee;
  v_salary := coalesce(r.monthly_salary, cfg.default_salary, 6000);
  v_basis  := coalesce(r.absence_basis, 'scheduled');
  v_fixed  := coalesce(r.absence_fixed_days, 26);

  select coalesce(array_agg(day_of_week order by day_of_week), '{}'::integer[])
    into v_off from public.ta_weekly_off_days where employee_id = p_employee;

  select count(*)::int into v_days
    from generate_series(v_start::timestamp, v_end::timestamp, interval '1 day') g(ts)
   where extract(dow from g.ts)::int <> all (v_off)
     and not exists (select 1 from public.ta_holidays h where h.holiday_date = g.ts::date);

  if v_basis = 'fixed_days' then
    v_daily := round(v_salary / greatest(v_fixed, 1), 2);
  else
    v_daily := case when v_days > 0 then round(v_salary / v_days, 2) else 0 end;
  end if;

  return jsonb_build_object(
    'salary', v_salary, 'working_days', v_days, 'daily_rate', v_daily,
    'basis', v_basis, 'fixed_days', v_fixed, 'off_days', to_jsonb(v_off));
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. LATENESS OF ONE CLOCK-IN, against the employee's own shift
-- ─────────────────────────────────────────────────────────────────────────────
--  { late_minutes, is_late, label, deduction_days, amount, billable_minutes,
--    shift_start, shift_end, shift_name, clock_in_local, scheduled, mode }
--  `scheduled` is false on the employee's day off or a holiday — then nothing
--  is late and nothing is deducted, whatever the clock says.
create or replace function public.ta_lateness(p_employee uuid, p_clock_in timestamptz, p_work_date date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  cfg     public.ta_settings := public.ta_cfg();
  tz      text;
  r       public.ta_salary_rules;
  sh      public.ta_shifts;
  v_start time;
  v_end   time;
  v_name  text;
  v_off   integer[];
  v_sched boolean;
  v_local timestamp;
  v_late  integer := 0;
  v_rate  jsonb;
  v_ld    jsonb;
begin
  tz := coalesce(cfg.timezone, 'Africa/Cairo');
  select * into r from public.ta_salary_rules where employee_id = p_employee;
  select * into sh from public.ta_shifts
   where id = coalesce(r.shift_id, (select id from public.ta_shifts where code = 'shift_2'));
  v_start := coalesce(r.shift_start_override, sh.start_time, time '10:00');
  v_end   := coalesce(r.shift_end_override,   sh.end_time,   time '18:00');
  v_name  := coalesce(sh.name, 'Custom hours');

  select coalesce(array_agg(day_of_week), '{}'::integer[])
    into v_off from public.ta_weekly_off_days where employee_id = p_employee;
  v_sched := not (extract(dow from p_work_date)::int = any (v_off))
             and not exists (select 1 from public.ta_holidays h where h.holiday_date = p_work_date);

  v_rate := public.ta_daily_rate(p_employee, p_work_date);

  if p_clock_in is not null and v_sched then
    v_local := p_clock_in at time zone tz;
    v_late  := greatest(0, floor(extract(epoch from (v_local - (p_work_date + v_start))) / 60))::int;
  end if;

  v_ld := public.ta_late_deduction(
    case when v_sched then v_late else 0 end,
    coalesce(r.late_mode, 'tiered'),
    coalesce(r.grace_minutes, cfg.default_grace_minutes, 15),
    coalesce(r.late_deduction_per_minute, cfg.default_late_per_minute, 1),
    r.late_deduction_cap_per_day,
    (v_rate->>'daily_rate')::numeric);

  return v_ld || jsonb_build_object(
    'late_minutes', v_late,
    'scheduled', v_sched,
    'shift_start', to_char(v_start, 'HH24:MI'),
    'shift_end',   to_char(v_end,   'HH24:MI'),
    'shift_name',  v_name,
    'clock_in_local', case when p_clock_in is not null then to_char(p_clock_in at time zone tz, 'HH24:MI') end,
    'daily_rate', (v_rate->>'daily_rate')::numeric);
end $$;

-- Every clock-in in a date range, priced. Admins see everyone; an employee
-- sees only their own rows (the filter is inside the function, not the client).
create or replace function public.ta_attendance_lateness(
  p_from date, p_to date, p_employee uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); res jsonb;
begin
  if uid is null then
    raise exception 'You are not signed in.' using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Invalid date range.' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(
           public.ta_lateness(a.employee_id, a.clock_in, a.work_date)
           || jsonb_build_object('attendance_id', a.id, 'employee_id', a.employee_id,
                                 'work_date', to_char(a.work_date, 'YYYY-MM-DD'))
           order by a.work_date, a.clock_in), '[]'::jsonb)
    into res
    from public.ta_attendance a
   where a.work_date between p_from and p_to
     and a.clock_in is not null
     and (p_employee is null or a.employee_id = p_employee)
     and (a.employee_id = uid or public.ta_is_admin());
  return res;
end $$;

-- ============================================================================
--  THE PAYROLL CALCULATION — re-created for v8
--  ---------------------------------------------------------------------------
--  Same derivation as v7 (nothing is stored), with three changes:
--    • a late arrival is priced by ta_late_deduction() — tiered by default;
--    • every day carries late_label + late_days so screens can say WHY;
--    • today is 'not_in' (no verdict) until the employee's shift has ended —
--      it only becomes an absence once the shift end has passed.
--
--  Day classification, in priority order:
--    1. attendance row exists           → present / late
--    2. company holiday                 → holiday
--    3. employee's OWN weekly day off   → weekly_off
--    4. APPROVED vacation/leave request → leave
--    5. APPROVED rest day               → rest_day
--    6. APPROVED permission covering the WHOLE scheduled shift → permission
--    7. later than today (local)        → upcoming
--    8. today, shift not over yet       → not_in
--    9. otherwise                       → absent
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
  v_now_time    time;
  v_counted     date;
  v_shift_start time;
  v_shift_end   time;
  v_shift_name  text;
  v_off         integer[];
  v_rate        jsonb;
  v_tiers       jsonb;

  v_salary      numeric(12,2);
  v_shift_id    uuid;
  v_late_mode   text;
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
  v_ld          jsonb;
  v_late_label  text;
  v_late_days   numeric(6,3);
  v_day_ded     numeric(12,2);
  v_type        text;

  t_scheduled   integer := 0;
  t_present     integer := 0;
  t_on_time     integer := 0;
  t_late_days   integer := 0;
  t_late_bill   integer := 0;
  t_late_raw    integer := 0;
  t_late_frac   numeric(8,3) := 0;
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
  t_not_in      integer := 0;

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

  v_start    := make_date(p_year, p_month, 1);
  v_end      := (v_start + interval '1 month - 1 day')::date;
  v_today    := (now() at time zone tz)::date;
  v_now_time := (now() at time zone tz)::time;
  v_counted  := least(v_end, v_today);

  -- ── Rules (a missing row falls back to the company defaults) ──────────────
  select * into r from public.ta_salary_rules where employee_id = p_employee;

  v_salary     := coalesce(r.monthly_salary, cfg.default_salary, 6000);
  v_shift_id   := coalesce(r.shift_id, (select id from public.ta_shifts where code = 'shift_2'));
  v_late_mode  := coalesce(r.late_mode, 'tiered');
  v_grace      := case when v_late_mode = 'tiered' then public.ta_late_grace()
                       else coalesce(r.grace_minutes, cfg.default_grace_minutes, 15) end;
  v_late_rate  := coalesce(r.late_deduction_per_minute, cfg.default_late_per_minute, 1);
  v_late_cap   := r.late_deduction_cap_per_day;
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

  -- The employee's OWN off-days and daily rate — shared with ta_lateness().
  v_rate      := public.ta_daily_rate(p_employee, v_start);
  t_scheduled := (v_rate->>'working_days')::int;
  v_daily     := (v_rate->>'daily_rate')::numeric;
  v_base      := v_salary;
  select coalesce(array_agg(x::int order by x::int), '{}'::integer[]) into v_off
    from jsonb_array_elements_text(v_rate->'off_days') x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'threshold_minutes', lt.threshold_minutes, 'deduction_days', lt.deduction_days, 'label', lt.label)
           order by lt.threshold_minutes), '[]'::jsonb)
    into v_tiers from public.ta_late_tiers lt;

  -- ── Walk the month ────────────────────────────────────────────────────────
  for d in select g.ts::date
             from generate_series(v_start::timestamp, v_end::timestamp, interval '1 day') g(ts)
  loop
    v_dow      := extract(dow from d)::int;
    v_holiday  := (select h.name from public.ta_holidays h where h.holiday_date = d);
    v_is_off   := v_dow = any (v_off);
    v_leave_type := null;
    v_late := 0; v_bill := 0; v_day_ded := 0; v_perm_ded := 0;
    v_late_label := null; v_late_days := 0;

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

    select count(*)::int, coalesce(sum(lp.duration_minutes), 0)::int,
           coalesce(bool_or(lp.start_time <= v_shift_start and lp.end_time >= v_shift_end), false)
      into v_perm_cnt, v_perm_min, v_perm_all
      from public.ta_leave_permissions lp
     where lp.employee_id = p_employee and lp.permission_date = d and lp.status = 'approved';

    if v_perm_cnt > 0 then
      t_perm_cnt := t_perm_cnt + v_perm_cnt;
      t_perm_min := t_perm_min + v_perm_min;
      if v_perm_on then
        if v_perm_mode = 'per_minute' then
          v_perm_ded := round(v_perm_min * v_perm_rate, 2);
        elsif v_perm_mode = 'per_occurrence' then
          v_perm_ded := round(v_perm_cnt * v_perm_rate, 2);
        end if;
        t_perm_ded := t_perm_ded + v_perm_ded;
      end if;
    end if;

    select * into att from public.ta_attendance
     where employee_id = p_employee and work_date = d;

    if found and att.clock_in is not null then
      v_type    := 'present';
      t_present := t_present + 1;
      t_worked_min := t_worked_min + coalesce(att.total_minutes, 0);

      -- Lateness only on a day the employee was scheduled to work — turning
      -- up on their day off or a holiday is never penalised.
      if not v_is_off and v_holiday is null then
        v_local := att.clock_in at time zone tz;
        v_sched := d + v_shift_start;
        v_late  := greatest(0, floor(extract(epoch from (v_local - v_sched)) / 60))::int;
        v_ld    := public.ta_late_deduction(v_late, v_late_mode, v_grace, v_late_rate, v_late_cap, v_daily);
        v_bill       := (v_ld->>'billable_minutes')::int;
        v_late_label := v_ld->>'label';
        v_late_days  := (v_ld->>'deduction_days')::numeric;
        if (v_ld->>'is_late')::boolean then
          v_type      := 'late';
          v_day_ded   := (v_ld->>'amount')::numeric;
          t_late_days := t_late_days + 1;
          t_late_bill := t_late_bill + v_bill;
          t_late_raw  := t_late_raw + v_late;
          t_late_frac := t_late_frac + v_late_days;
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
      v_type := 'permission'; t_perm_days := t_perm_days + 1;
    elsif d > v_counted then
      v_type := 'upcoming';
    elsif d = v_today and (v_shift_end <= v_shift_start or v_now_time < v_shift_end) then
      -- Today, and the shift is still running: no verdict yet. It becomes an
      -- absence only once the shift end has passed with no clock-in.
      v_type := 'not_in';     t_not_in := t_not_in + 1;
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
      'attendance_status',    att.status,
      'clock_in_local',       case when att.clock_in is not null
                                then to_char(att.clock_in at time zone tz, 'HH24:MI') end,
      'clock_out_local',      case when att.clock_out is not null
                                then to_char(att.clock_out at time zone tz, 'HH24:MI') end,
      'worked_minutes',       coalesce(att.total_minutes, 0),
      'late_minutes',         v_late,
      'billable_minutes',     v_bill,
      'late_label',           v_late_label,
      'late_days',            v_late_days,
      'permission_count',     v_perm_cnt,
      'permission_minutes',   v_perm_min,
      'permission_deduction', v_perm_ded,
      'deduction',            v_day_ded);
  end loop;

  -- ── Money ─────────────────────────────────────────────────────────────────
  v_absent_ded := round(t_absent * v_daily * v_abs_mult, 2);

  if v_perm_on and v_perm_mode = 'fixed' and t_perm_cnt > 0 then
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
      'avatar_url', prof.avatar_url, 'role', prof.role, 'is_manager', prof.is_manager),
    'period', jsonb_build_object(
      'year', p_year, 'month', p_month,
      'start', to_char(v_start, 'YYYY-MM-DD'),
      'end',   to_char(v_end,   'YYYY-MM-DD'),
      'counted_to', to_char(v_counted, 'YYYY-MM-DD'),
      'today', to_char(v_today, 'YYYY-MM-DD'),
      'is_current', (v_today between v_start and v_end),
      'timezone', tz),
    'rules', jsonb_build_object(
      'monthly_salary', v_salary,
      'shift_id', v_shift_id,
      'shift_name', v_shift_name,
      'shift_start', to_char(v_shift_start, 'HH24:MI'),
      'shift_end',   to_char(v_shift_end,   'HH24:MI'),
      'late_mode', v_late_mode,
      'late_tiers', v_tiers,
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
      'late_day_fraction', t_late_frac,
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
      'not_in_days', t_not_in,
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. EMPLOYEE BOARD — everything one card needs, in one round trip. Admin only.
-- ─────────────────────────────────────────────────────────────────────────────
--  Each element = ta_payroll(employee, year, month) without the per-day list,
--  plus:
--    today            the day entry for TODAY (company timezone), whichever
--                     month is being viewed — this is the card's live status
--    attendance_today the raw ta_attendance row for today (or null)
--    balances         vacation balances [{leave_type,total,used,remaining}]
--    pending_leaves   vacation requests still waiting for a decision
--    permission_usage the ta_permission_usage() counter for the viewed month
create or replace function public.ta_employee_board(
  p_year integer, p_month integer, p_include_inactive boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  res      jsonb := '[]'::jsonb;
  p        record;
  pay      jsonb;
  cur      jsonb;
  td       jsonb;
  v_today  date;
  v_att    jsonb;
  v_bal    jsonb;
  v_pend   integer;
  v_usage  jsonb;
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can view the employee board.' using errcode = 'P0001';
  end if;
  v_today := public.ta_today_local();

  for p in
    select pr.id, pr.full_name
      from public.ta_profiles pr
      left join public.ta_salary_rules s on s.employee_id = pr.id
     where pr.role = 'employee'
       and (p_include_inactive or coalesce(s.is_active, true))
     order by pr.full_name
  loop
    pay := public.ta_payroll(p.id, p_year, p_month);

    -- Today's entry: from the viewed month if it contains today, otherwise
    -- from the current month (so the live status never depends on the picker).
    if (pay->'period'->>'is_current')::boolean then
      cur := pay;
    else
      cur := public.ta_payroll(p.id, extract(year from v_today)::int, extract(month from v_today)::int);
    end if;
    select x into td from jsonb_array_elements(cur->'days') x
     where x->>'date' = to_char(v_today, 'YYYY-MM-DD');

    select to_jsonb(a) into v_att from public.ta_attendance a
     where a.employee_id = p.id and a.work_date = v_today;

    select coalesce(jsonb_agg(jsonb_build_object(
             'leave_type', b.leave_type, 'total', b.total_days,
             'used', b.used_days, 'remaining', b.remaining_days) order by b.leave_type), '[]'::jsonb)
      into v_bal from public.ta_leave_balances b where b.employee_id = p.id;

    select count(*)::int into v_pend
      from public.ta_leave_requests lr where lr.employee_id = p.id and lr.status = 'pending';

    begin
      v_usage := public.ta_permission_usage(p.id, p_year, p_month);
    exception when others then
      v_usage := null;
    end;

    res := res || ((pay - 'days') || jsonb_build_object(
      'today', td,
      'attendance_today', v_att,
      'balances', v_bal,
      'pending_leaves', v_pend,
      'permission_usage', v_usage));
  end loop;
  return res;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. ADMIN WRITE RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Replace the late tiers ──────────────────────────────────────────────────
--  p_tiers = [{threshold_minutes, deduction_days, label}, …]. Thresholds must
--  be distinct and the deductions must not decrease as the threshold grows —
--  a later arrival can never cost less than an earlier one.
create or replace function public.ta_set_late_tiers(p_tiers jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t        jsonb;
  v_n      integer;
  v_prev_t integer := -1;
  v_prev_d numeric := -1;
  v_thr    integer;
  v_days   numeric;
  v_label  text;
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can change the late-arrival rules.' using errcode = 'P0001';
  end if;
  if p_tiers is null or jsonb_typeof(p_tiers) <> 'array' then
    raise exception 'Send the tiers as a list.' using errcode = 'P0001';
  end if;
  v_n := jsonb_array_length(p_tiers);
  if v_n < 1 or v_n > 10 then
    raise exception 'Between 1 and 10 tiers are allowed.' using errcode = 'P0001';
  end if;

  for t in
    select x from jsonb_array_elements(p_tiers) x order by (x->>'threshold_minutes')::int
  loop
    v_thr   := (t->>'threshold_minutes')::int;
    v_days  := (t->>'deduction_days')::numeric;
    v_label := nullif(btrim(coalesce(t->>'label', '')), '');
    if v_thr is null or v_thr < 0 or v_thr > 1440 then
      raise exception 'A threshold must be between 0 and 1440 minutes.' using errcode = 'P0001';
    end if;
    if v_days is null or v_days < 0 or v_days > 5 then
      raise exception 'A deduction must be between 0 and 5 days.' using errcode = 'P0001';
    end if;
    if v_thr = v_prev_t then
      raise exception 'Two tiers share the % minute threshold.', v_thr using errcode = 'P0001';
    end if;
    if v_days < v_prev_d then
      raise exception 'A later arrival cannot cost less than an earlier one (tier at % min).', v_thr using errcode = 'P0001';
    end if;
    if v_label is null then
      raise exception 'Give the tier at % minutes a name.', v_thr using errcode = 'P0001';
    end if;
    v_prev_t := v_thr; v_prev_d := v_days;
  end loop;

  delete from public.ta_late_tiers;
  insert into public.ta_late_tiers (threshold_minutes, deduction_days, label, updated_by)
  select (x->>'threshold_minutes')::int, (x->>'deduction_days')::numeric, btrim(x->>'label'), auth.uid()
    from jsonb_array_elements(p_tiers) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'threshold_minutes', lt.threshold_minutes, 'deduction_days', lt.deduction_days, 'label', lt.label)
           order by lt.threshold_minutes), '[]'::jsonb)
    into t from public.ta_late_tiers lt;
  return t;
end $$;

-- ── Per-employee rules — v7 signature + p_late_mode ─────────────────────────
--  The v7 overload is dropped first: two ta_set_salary_rules() whose named
--  parameters overlap would make PostgREST refuse the call as ambiguous.
--  Salary edits from the quick "Edit salary" control call THIS function with
--  only p_employee + p_monthly_salary — no second salary path exists.
drop function if exists public.ta_set_salary_rules(
  uuid, numeric, uuid, integer, numeric, text, integer, numeric,
  integer[], boolean, time, time, numeric, boolean, text,
  integer, boolean, text, numeric);

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
  p_permission_deduction_rate    numeric default null,
  p_late_mode           text      default null)
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
  if p_monthly_salary is not null and (p_monthly_salary < 0 or p_monthly_salary > 100000000) then
    raise exception 'Enter a salary between 0 and 100,000,000.' using errcode = 'P0001';
  end if;
  if p_grace is not null and (p_grace < 0 or p_grace > 240) then
    raise exception 'The grace period must be between 0 and 240 minutes.' using errcode = 'P0001';
  end if;
  if p_late_per_minute is not null and p_late_per_minute < 0 then
    raise exception 'The late deduction cannot be negative.' using errcode = 'P0001';
  end if;
  if p_late_mode is not null and p_late_mode not in ('tiered', 'per_minute') then
    raise exception 'Unknown late-arrival rule.' using errcode = 'P0001';
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
    late_mode                  = coalesce(p_late_mode,          late_mode),
    absence_basis              = coalesce(p_absence_basis,      absence_basis),
    absence_fixed_days         = coalesce(p_absence_fixed_days, absence_fixed_days),
    absence_multiplier         = coalesce(p_absence_multiplier, absence_multiplier),
    is_active                  = coalesce(p_is_active,          is_active),
    permissions_per_month        = coalesce(p_permissions_per_month,        permissions_per_month),
    permission_deduction_enabled = coalesce(p_permission_deduction_enabled, permission_deduction_enabled),
    permission_deduction_mode    = coalesce(p_permission_deduction_mode,    permission_deduction_mode),
    permission_deduction_rate    = coalesce(p_permission_deduction_rate,    permission_deduction_rate),
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
     or before.late_deduction_per_minute is distinct from r.late_deduction_per_minute
     or before.late_mode is distinct from r.late_mode then
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

-- ============================================================================
--  ROW LEVEL SECURITY + GRANTS
-- ============================================================================
alter table public.ta_late_tiers enable row level security;

-- Everyone reads the rule (the employee's own salary screen explains it);
-- nobody writes it over the API — ta_set_late_tiers() is the only route.
drop policy if exists ta_latetier_sel on public.ta_late_tiers;
create policy ta_latetier_sel on public.ta_late_tiers for select to authenticated using (true);

grant select on public.ta_late_tiers to authenticated;
revoke insert, update, delete on public.ta_late_tiers from authenticated;

grant execute on function public.ta_late_tier(integer)                                   to authenticated;
grant execute on function public.ta_late_grace()                                         to authenticated;
grant execute on function public.ta_late_deduction(integer, text, integer, numeric, numeric, numeric) to authenticated;
grant execute on function public.ta_daily_rate(uuid, date)                               to authenticated;
grant execute on function public.ta_lateness(uuid, timestamptz, date)                    to authenticated;
grant execute on function public.ta_attendance_lateness(date, date, uuid)                to authenticated;
grant execute on function public.ta_payroll(uuid, integer, integer)                      to authenticated;
grant execute on function public.ta_employee_board(integer, integer, boolean)            to authenticated;
grant execute on function public.ta_set_late_tiers(jsonb)                                to authenticated;
grant execute on function public.ta_set_salary_rules(
  uuid, numeric, uuid, integer, numeric, text, integer, numeric,
  integer[], boolean, time, time, numeric, boolean, text,
  integer, boolean, text, numeric, text)                                                 to authenticated;

-- ta_daily_rate / ta_lateness are SECURITY DEFINER and read another
-- employee's rules, so they must not leak pay to a colleague. ta_lateness is
-- only reachable through ta_attendance_lateness (which filters by caller) and
-- ta_daily_rate through ta_payroll (which checks the caller) — revoke the
-- direct API route for both.
revoke execute on function public.ta_daily_rate(uuid, date)            from public, anon, authenticated;
revoke execute on function public.ta_lateness(uuid, timestamptz, date) from public, anon, authenticated;

-- ============================================================================
--  DONE. Sanity checks
-- ----------------------------------------------------------------------------
--  a) The tiers and the boundary rule:
--       select threshold_minutes, deduction_days, label from public.ta_late_tiers order by 1;
--       select m, (public.ta_late_tier(m)).label from unnest(array[0,15,16,30,31,60,61]) m;
--       -- expect: 0 →null · 15 →null · 16 →Quarter · 30 →Quarter · 31 →Half · 60 →Half · 61 →Full
--
--  b) Everyone is on the tiered rule (expect 0 rows):
--       select employee_id from public.ta_salary_rules where late_mode <> 'tiered';
--
--  c) The tier table is read-only over the API (all FALSE):
--       select has_table_privilege('authenticated','public.ta_late_tiers','UPDATE'),
--              has_table_privilege('authenticated','public.ta_late_tiers','INSERT');
--
--  d) A priced month for one person, then the board (admin session):
--       select public.ta_payroll((select id from public.ta_profiles order by full_name limit 1), 2026, 9);
--       select public.ta_employee_board(2026, 9);
--
--  If a screen reports "Could not find the function", run:
--       notify pgrst, 'reload schema';
-- ============================================================================
