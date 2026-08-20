-- ============================================================================
--  RingRoad — Attendance & Time-Off :: SCHEMA v2  (ADDITIVE MIGRATION)
--  ---------------------------------------------------------------------------
--  Run this ONCE in the Supabase SQL editor AFTER db/schema.sql.
--  It is idempotent — safe to re-run — and purely additive: it never drops a
--  table, a column or any existing data. Every object stays namespaced `ta_`.
--
--  What it adds
--  ------------
--   1. ta_settings              — singleton config: geofence centre/radius, rest allotment
--   2. ta_weekend_change_requests · ta_rest_day_requests · ta_rest_balances
--   3. geofence columns on ta_attendance + ta_geo_attempts audit log
--   4. SECURITY DEFINER RPCs that are the ONLY write path for these features:
--        ta_clock_in / ta_clock_out            (geofence enforced server-side)
--        ta_request_weekend_change / ta_review_weekend_change
--        ta_request_rest_days / ta_review_rest_days
--        ta_set_geofence / ta_set_rest_balance
--   5. RLS + GRANTs tightened so a hand-crafted PostgREST call CANNOT bypass
--      any business rule (employees get SELECT only on the new tables, and
--      lose direct INSERT/UPDATE on ta_attendance).
--
--  BUSINESS RULES ENFORCED IN THE DATABASE
--  ---------------------------------------
--   • Max 2 weekend changes per user  (partial unique index + guard in the RPC)
--   • 1st change auto-approved & applied immediately; 2nd needs admin approval
--   • A change REJECTED by an admin does not burn the slot (the user may
--     re-submit); pending / approved / auto-approved ones do.
--   • Rest days: requested count must fit the available balance
--     (total − used − already-pending). Overlaps with existing rest days, leave
--     requests, recorded attendance and weekly off-days are refused.
--   • Clock in/out: distance is recomputed on the server from the submitted
--     coordinates against ta_settings; any distance sent by the client is
--     ignored, and every attempt (pass or fail) is logged.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. ENUMS
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  create type ta_weekend_status as enum ('auto_approved', 'pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. SETTINGS (singleton row — id is always true)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ta_settings (
  id                  boolean primary key default true check (id),
  -- Official attendance location (RingRoad office).
  geofence_lat        double precision not null default 29.979897570225,
  geofence_lng        double precision not null default 31.357097369334436,
  -- Allowed radius in metres. Hard-bounded to 100..200 by the CHECK.
  geofence_radius_m   integer not null default 150 check (geofence_radius_m between 100 and 200),
  -- Reject readings whose reported accuracy is worse than this (metres).
  max_accuracy_m      integer not null default 250 check (max_accuracy_m between 20 and 2000),
  geofence_enabled    boolean not null default true,
  -- Default rest-day allotment for newly provisioned employees.
  rest_days_default   integer not null default 4 check (rest_days_default >= 0),
  -- Weekend changes allowed per employee. Fixed at 2 by the CHECK.
  max_weekend_changes integer not null default 2 check (max_weekend_changes = 2),
  updated_by          uuid references public.ta_profiles(id),
  updated_at          timestamptz not null default now()
);
insert into public.ta_settings (id) values (true) on conflict (id) do nothing;

-- Convenience accessor used by every RPC below.
create or replace function public.ta_cfg()
returns public.ta_settings language sql stable security definer set search_path = public as $$
  select * from public.ta_settings where id = true;
$$;

-- Pretty day names for notification text: '{5,6}' -> 'Friday, Saturday'.
create or replace function public.ta_days_label(p_days smallint[])
returns text language sql immutable as $$
  select coalesce(string_agg(
    (array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])[d + 1],
    ', ' order by d), '—')
  from unnest(coalesce(p_days, '{}'::smallint[])) as d;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. WEEKEND CHANGE REQUESTS
--    original_days / requested_days use the JS getDay() convention 0=Sun..6=Sat,
--    exactly like ta_weekly_off_days.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ta_weekend_change_requests (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.ta_profiles(id) on delete cascade,
  original_days  smallint[] not null default '{}',
  requested_days smallint[] not null,
  change_number  smallint not null check (change_number between 1 and 2),
  status         ta_weekend_status not null,
  reason         text,
  requested_at   timestamptz not null default now(),
  reviewed_by    uuid references public.ta_profiles(id),
  reviewed_at    timestamptz,
  admin_note     text,
  applied        boolean not null default false,
  applied_at     timestamptz,
  check (array_length(requested_days, 1) between 1 and 3)
);
create index if not exists idx_ta_wcr_emp    on public.ta_weekend_change_requests(employee_id);
create index if not exists idx_ta_wcr_status on public.ta_weekend_change_requests(status);

-- HARD CAP: at most one live request per slot, and only slots 1 and 2 exist
-- (change_number CHECK). Rejected rows fall out of the index so a rejected
-- attempt can be re-submitted without consuming an allowance.
create unique index if not exists uq_ta_wcr_live_slot
  on public.ta_weekend_change_requests(employee_id, change_number)
  where status <> 'rejected';

-- How many of the 2 allowances a user has consumed.
create or replace function public.ta_weekend_used(p_emp uuid)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from public.ta_weekend_change_requests
   where employee_id = p_emp and status <> 'rejected';
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. REST DAYS — balance + requests
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ta_rest_balances (
  employee_id    uuid primary key references public.ta_profiles(id) on delete cascade,
  total_days     integer not null default 4 check (total_days >= 0),
  used_days      integer not null default 0 check (used_days >= 0),
  remaining_days integer generated always as (total_days - used_days) stored,
  updated_at     timestamptz not null default now()
);

create table if not exists public.ta_rest_day_requests (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.ta_profiles(id) on delete cascade,
  -- The requested rest PERIOD (duration) …
  start_date      date not null,
  end_date        date not null,
  -- … and the exact dates picked inside it.
  dates           date[] not null,
  days_count      integer not null check (days_count > 0),
  balance_before  integer not null,
  balance_after   integer,
  reason          text,
  status          ta_leave_status not null default 'pending',
  reviewed_by     uuid references public.ta_profiles(id),
  reviewed_at     timestamptz,
  admin_note      text,
  created_at      timestamptz not null default now(),
  check (end_date >= start_date),
  check (array_length(dates, 1) = days_count)
);
create index if not exists idx_ta_rdr_emp    on public.ta_rest_day_requests(employee_id);
create index if not exists idx_ta_rdr_status on public.ta_rest_day_requests(status);

-- Rest days already spoken for by pending requests.
create or replace function public.ta_rest_pending_days(p_emp uuid)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(days_count), 0)::int from public.ta_rest_day_requests
   where employee_id = p_emp and status = 'pending';
$$;

-- What the employee can actually still request right now.
create or replace function public.ta_rest_available(p_emp uuid)
returns integer language sql stable security definer set search_path = public as $$
  select greatest(0,
    coalesce((select remaining_days from public.ta_rest_balances where employee_id = p_emp), 0)
    - public.ta_rest_pending_days(p_emp));
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. GEOFENCE — columns on ta_attendance + full attempt log
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.ta_attendance
  add column if not exists clock_in_lat          double precision,
  add column if not exists clock_in_lng          double precision,
  add column if not exists clock_in_accuracy_m   numeric(10,2),
  add column if not exists clock_in_distance_m   numeric(10,2),
  add column if not exists clock_in_radius_m     integer,
  add column if not exists clock_in_geofence_ok  boolean,
  add column if not exists clock_out_lat         double precision,
  add column if not exists clock_out_lng         double precision,
  add column if not exists clock_out_accuracy_m  numeric(10,2),
  add column if not exists clock_out_distance_m  numeric(10,2),
  add column if not exists clock_out_radius_m    integer,
  add column if not exists clock_out_geofence_ok boolean;

-- Every attempt — allowed AND blocked — is recorded here.
create table if not exists public.ta_geo_attempts (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.ta_profiles(id) on delete cascade,
  action      text not null check (action in ('clock_in','clock_out')),
  lat         double precision,
  lng         double precision,
  accuracy_m  numeric(10,2),
  distance_m  numeric(10,2),
  radius_m    integer,
  passed      boolean not null,
  reason      text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_ta_geo_emp  on public.ta_geo_attempts(employee_id);
create index if not exists idx_ta_geo_time on public.ta_geo_attempts(created_at desc);

-- Great-circle (haversine) distance in metres.
create or replace function public.ta_distance_m(
  p_lat1 double precision, p_lng1 double precision,
  p_lat2 double precision, p_lng2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371000 * asin(least(1, sqrt(
      power(sin(radians(p_lat2 - p_lat1) / 2), 2)
    + cos(radians(p_lat1)) * cos(radians(p_lat2))
    * power(sin(radians(p_lng2 - p_lng1) / 2), 2)
  )));
$$;

-- Postgres refuses to change a function's return type with CREATE OR REPLACE,
-- so drop any earlier revision of the clock RPCs first (they returned the
-- ta_attendance composite; they now return jsonb). Safe on a fresh install.
drop function if exists public.ta_clock_in(double precision, double precision, double precision);
drop function if exists public.ta_clock_out(double precision, double precision, double precision);
drop function if exists public.ta_geo_eval(double precision, double precision, double precision);

-- Pure geofence evaluation — no writes, no exceptions. Returns the verdict so
-- the caller can LOG the attempt and still return a failure without rolling
-- that log entry back (a `raise` would undo the audit insert).
create or replace function public.ta_geo_eval(
  p_lat double precision, p_lng double precision, p_accuracy double precision)
returns table (ok boolean, distance numeric, radius integer, reason text, message text)
language plpgsql stable security definer set search_path = public as $$
declare
  cfg    public.ta_settings;
  v_dist numeric;
begin
  cfg    := public.ta_cfg();
  radius := cfg.geofence_radius_m;

  v_dist := case when p_lat is null or p_lng is null
                   or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180
                 then null
                 else round(public.ta_distance_m(p_lat, p_lng, cfg.geofence_lat, cfg.geofence_lng)::numeric, 2) end;
  distance := v_dist;

  if not cfg.geofence_enabled then
    ok := true; reason := 'geofence disabled'; message := null; return next; return;
  end if;

  -- Missing / impossible coordinates. Also catches a client that simply omits
  -- them in a hand-crafted request.
  if p_lat is null or p_lng is null
     or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180
     or (p_lat = 0 and p_lng = 0) then
    ok := false; reason := 'invalid or missing coordinates';
    message := 'Location required. Enable GPS / location access and try again.';
    return next; return;
  end if;

  -- Implausible accuracy: absent, non-positive (spoofed) or far too coarse.
  if p_accuracy is null or p_accuracy <= 0 or p_accuracy > cfg.max_accuracy_m then
    ok := false; reason := 'gps accuracy rejected';
    message := format('Your GPS signal is too weak to confirm your location (accuracy must be within %s m). Move to an open area and try again.',
                      cfg.max_accuracy_m);
    return next; return;
  end if;

  if v_dist > cfg.geofence_radius_m then
    ok := false; reason := 'outside radius';
    message := format('You are outside the allowed attendance area. Please move closer to the attendance location. You are about %s m away — the allowed radius is %s m.',
                      round(v_dist)::int, cfg.geofence_radius_m);
    return next; return;
  end if;

  ok := true; reason := 'inside radius'; message := null;
  return next;
end $$;

-- ── CLOCK IN ────────────────────────────────────────────────────────────────
--  Returns jsonb rather than raising, so the ta_geo_attempts row written for a
--  BLOCKED attempt survives (an exception would roll the whole call back and
--  the audit log would only ever contain successes).
--    { ok, error, reason, distance_m, radius_m, record }
create or replace function public.ta_clock_in(
  p_lat double precision, p_lng double precision, p_accuracy double precision default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cfg public.ta_settings;
  g   record;
  rec public.ta_attendance;
  uid uuid := auth.uid();
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'Not signed in', 'reason', 'no session');
  end if;
  cfg := public.ta_cfg();
  select * into g from public.ta_geo_eval(p_lat, p_lng, p_accuracy);

  -- Log EVERY attempt, passed or blocked.
  insert into public.ta_geo_attempts (employee_id, action, lat, lng, accuracy_m, distance_m, radius_m, passed, reason)
  values (uid, 'clock_in', p_lat, p_lng, p_accuracy, g.distance, g.radius, g.ok, g.reason);

  if not g.ok then
    return jsonb_build_object('ok', false, 'error', g.message, 'reason', g.reason,
                              'distance_m', g.distance, 'radius_m', g.radius);
  end if;

  if exists (select 1 from public.ta_attendance where employee_id = uid and work_date = current_date) then
    return jsonb_build_object('ok', false, 'error', 'You have already clocked in today.', 'reason', 'duplicate');
  end if;

  -- Nested block so a lost race against the unique index doesn't roll back the
  -- audit row written above.
  begin
    insert into public.ta_attendance (
      employee_id, work_date, clock_in, status,
      clock_in_lat, clock_in_lng, clock_in_accuracy_m, clock_in_distance_m,
      clock_in_radius_m, clock_in_geofence_ok)
    values (uid, current_date, now(), 'working',
            p_lat, p_lng, p_accuracy, g.distance, g.radius, true)
    returning * into rec;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'You have already clocked in today.', 'reason', 'duplicate');
  end;

  return jsonb_build_object('ok', true, 'record', to_jsonb(rec),
                            'distance_m', g.distance, 'radius_m', g.radius);
end $$;

-- ── CLOCK OUT ───────────────────────────────────────────────────────────────
create or replace function public.ta_clock_out(
  p_lat double precision, p_lng double precision, p_accuracy double precision default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cfg  public.ta_settings;
  g    record;
  rec  public.ta_attendance;
  uid  uuid := auth.uid();
  mins integer;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'Not signed in', 'reason', 'no session');
  end if;
  cfg := public.ta_cfg();
  select * into g from public.ta_geo_eval(p_lat, p_lng, p_accuracy);

  insert into public.ta_geo_attempts (employee_id, action, lat, lng, accuracy_m, distance_m, radius_m, passed, reason)
  values (uid, 'clock_out', p_lat, p_lng, p_accuracy, g.distance, g.radius, g.ok, g.reason);

  if not g.ok then
    return jsonb_build_object('ok', false, 'error', g.message, 'reason', g.reason,
                              'distance_m', g.distance, 'radius_m', g.radius);
  end if;

  select * into rec from public.ta_attendance
   where employee_id = uid and work_date = current_date for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'You have not clocked in today.', 'reason', 'not clocked in');
  end if;
  if rec.clock_out is not null then
    return jsonb_build_object('ok', false, 'error', 'You have already clocked out today.', 'reason', 'already clocked out');
  end if;

  -- Minutes are computed on the SERVER from the stored clock_in — never taken
  -- from the client.
  mins := greatest(0, floor(extract(epoch from (now() - rec.clock_in)) / 60)::int);

  update public.ta_attendance
     set clock_out = now(), total_minutes = mins, status = 'completed',
         clock_out_lat = p_lat, clock_out_lng = p_lng, clock_out_accuracy_m = p_accuracy,
         clock_out_distance_m = g.distance, clock_out_radius_m = g.radius,
         clock_out_geofence_ok = true
   where id = rec.id
   returning * into rec;

  return jsonb_build_object('ok', true, 'record', to_jsonb(rec),
                            'distance_m', g.distance, 'radius_m', g.radius);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. WEEKEND CHANGE — request + review RPCs
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ta_request_weekend_change(
  p_days smallint[], p_reason text default null)
returns public.ta_weekend_change_requests
language plpgsql security definer set search_path = public as $$
declare
  cfg  public.ta_settings;
  uid  uuid := auth.uid();
  used integer;
  slot smallint;
  cur  smallint[];
  want smallint[];
  req  public.ta_weekend_change_requests;
begin
  if uid is null then raise exception 'Not signed in' using errcode = 'P0001'; end if;
  cfg := public.ta_cfg();

  -- Normalise: distinct, sorted, valid days only.
  select coalesce(array_agg(distinct d order by d), '{}')::smallint[] into want
    from unnest(coalesce(p_days, '{}'::smallint[])) as d
   where d between 0 and 6;

  if coalesce(array_length(want, 1), 0) < 1 then
    raise exception 'Pick at least one day for your new weekend.' using errcode = 'P0001';
  end if;
  if array_length(want, 1) > 3 then
    raise exception 'A weekend can be at most 3 days.' using errcode = 'P0001';
  end if;

  -- Serialise per employee so two parallel calls can't both grab the last slot.
  perform 1 from public.ta_profiles where id = uid for update;

  -- Allowance first, so someone who is out of changes is told THAT rather
  -- than something incidental about the days they happened to pick.
  if exists (select 1 from public.ta_weekend_change_requests
              where employee_id = uid and status = 'pending') then
    raise exception 'You already have a weekend change awaiting admin approval.' using errcode = 'P0001';
  end if;

  used := public.ta_weekend_used(uid);
  if used >= cfg.max_weekend_changes then
    raise exception 'You have used all % of your weekend changes. No further changes can be requested.',
      cfg.max_weekend_changes using errcode = 'P0001';
  end if;
  slot := (used + 1)::smallint;

  select coalesce(array_agg(day_of_week order by day_of_week), '{}')::smallint[] into cur
    from public.ta_weekly_off_days where employee_id = uid;

  if cur = want then
    raise exception 'That is already your current weekend.' using errcode = 'P0001';
  end if;
  -- You may MOVE your weekend, not lengthen it.
  if coalesce(array_length(cur, 1), 0) > 0
     and array_length(want, 1) <> array_length(cur, 1) then
    raise exception 'Your new weekend must have the same number of days as your current one (% day(s)).',
      array_length(cur, 1) using errcode = 'P0001';
  end if;


  if slot = 1 then
    -- FIRST change: auto-approved, effective immediately, no admin needed.
    insert into public.ta_weekend_change_requests
      (employee_id, original_days, requested_days, change_number, status, reason, applied, applied_at, reviewed_at)
    values (uid, cur, want, slot, 'auto_approved', p_reason, true, now(), now())
    returning * into req;

    delete from public.ta_weekly_off_days where employee_id = uid;
    insert into public.ta_weekly_off_days (employee_id, day_of_week)
    select uid, d from unnest(want) as d
    on conflict (employee_id, day_of_week) do nothing;

    insert into public.ta_notifications (employee_id, title, message, type)
    values (uid, 'Weekend Updated',
            format('Your weekend is now %s. That was change 1 of %s — no approval was needed.',
                   public.ta_days_label(want), cfg.max_weekend_changes),
            'weekend_approved');
  else
    -- SECOND change: needs an admin decision before it takes effect.
    insert into public.ta_weekend_change_requests
      (employee_id, original_days, requested_days, change_number, status, reason)
    values (uid, cur, want, slot, 'pending', p_reason)
    returning * into req;

    insert into public.ta_notifications (employee_id, title, message, type)
    values (uid, 'Weekend Change Submitted',
            format('Your request to move your weekend to %s is waiting for admin approval (change 2 of %s).',
                   public.ta_days_label(want), cfg.max_weekend_changes),
            'weekend_submitted');
  end if;

  return req;
end $$;

create or replace function public.ta_review_weekend_change(
  p_request_id uuid, p_decision text, p_note text default null)
returns public.ta_weekend_change_requests
language plpgsql security definer set search_path = public as $$
declare req public.ta_weekend_change_requests;
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can review weekend change requests' using errcode = 'P0001';
  end if;
  if p_decision not in ('approved','rejected') then
    raise exception 'decision must be approved or rejected' using errcode = 'P0001';
  end if;

  select * into req from public.ta_weekend_change_requests where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode = 'P0001'; end if;
  if req.status <> 'pending' then raise exception 'request already reviewed' using errcode = 'P0001'; end if;

  update public.ta_weekend_change_requests
     set status      = p_decision::ta_weekend_status,
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         admin_note  = p_note,
         applied     = (p_decision = 'approved'),
         applied_at  = case when p_decision = 'approved' then now() end
   where id = p_request_id
   returning * into req;

  if p_decision = 'approved' then
    delete from public.ta_weekly_off_days where employee_id = req.employee_id;
    insert into public.ta_weekly_off_days (employee_id, day_of_week)
    select req.employee_id, d from unnest(req.requested_days) as d
    on conflict (employee_id, day_of_week) do nothing;

    insert into public.ta_notifications (employee_id, title, message, type)
    values (req.employee_id, 'Weekend Change Approved',
            format('Your weekend is now %s.', public.ta_days_label(req.requested_days)), 'weekend_approved');
  else
    insert into public.ta_notifications (employee_id, title, message, type)
    values (req.employee_id, 'Weekend Change Rejected',
            format('Your request to move your weekend to %s was rejected.%s',
                   public.ta_days_label(req.requested_days),
                   case when p_note is null or p_note = '' then '' else ' Note: ' || p_note end),
            'weekend_rejected');
  end if;

  return req;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. REST DAYS — request + review RPCs
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ta_request_rest_days(
  p_dates date[], p_reason text default null)
returns public.ta_rest_day_requests
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  want  date[];
  n     integer;
  avail integer;
  pend  integer;
  clash date;
  req   public.ta_rest_day_requests;
begin
  if uid is null then raise exception 'Not signed in' using errcode = 'P0001'; end if;

  -- Normalise: distinct, sorted.
  select coalesce(array_agg(distinct d order by d), '{}')::date[] into want
    from unnest(coalesce(p_dates, '{}'::date[])) as d;

  n := coalesce(array_length(want, 1), 0);
  if n = 0 then raise exception 'Select at least one rest day.' using errcode = 'P0001'; end if;
  if n > 31 then raise exception 'You cannot request more than 31 rest days at once.' using errcode = 'P0001'; end if;
  if want[1] < current_date then
    raise exception 'Rest days cannot be requested for a date in the past.' using errcode = 'P0001';
  end if;

  -- Serialise per employee so two parallel requests can't both pass the check.
  perform 1 from public.ta_profiles where id = uid for update;

  -- ── AVAILABILITY — the rule users must not be able to bypass ──────────────
  avail := public.ta_rest_available(uid);
  pend  := public.ta_rest_pending_days(uid);
  if n > avail then
    raise exception 'You do not have enough available rest days. You requested % but only % remain%s.',
      n, avail,
      case when pend > 0 then format(' (%s day(s) already reserved by a pending request)', pend) else '' end
      using errcode = 'P0001';
  end if;

  -- ── CONFLICTS ─────────────────────────────────────────────────────────────
  select d into clash from unnest(want) as d
   where exists (
     select 1 from public.ta_rest_day_requests r
      where r.employee_id = uid and r.status in ('pending','approved') and d = any (r.dates))
   limit 1;
  if clash is not null then
    raise exception 'You already have a rest-day request covering %.', to_char(clash, 'Mon DD, YYYY') using errcode = 'P0001';
  end if;

  select d into clash from unnest(want) as d
   where exists (
     select 1 from public.ta_leave_requests l
      where l.employee_id = uid and l.status in ('pending','approved')
        and d between l.start_date and l.end_date)
   limit 1;
  if clash is not null then
    raise exception 'You already have a leave request covering %.', to_char(clash, 'Mon DD, YYYY') using errcode = 'P0001';
  end if;

  select d into clash from unnest(want) as d
   where exists (select 1 from public.ta_attendance a where a.employee_id = uid and a.work_date = d)
   limit 1;
  if clash is not null then
    raise exception 'You already have attendance recorded on %.', to_char(clash, 'Mon DD, YYYY') using errcode = 'P0001';
  end if;

  select d into clash from unnest(want) as d
   where exists (select 1 from public.ta_weekly_off_days w
                  where w.employee_id = uid and w.day_of_week = extract(dow from d)::int)
   limit 1;
  if clash is not null then
    raise exception '% is already one of your weekly off-days.', to_char(clash, 'Mon DD, YYYY') using errcode = 'P0001';
  end if;

  insert into public.ta_rest_day_requests
    (employee_id, start_date, end_date, dates, days_count, balance_before, reason, status)
  values (uid, want[1], want[n], want, n, avail, p_reason, 'pending')
  returning * into req;

  insert into public.ta_notifications (employee_id, title, message, type)
  values (uid, 'Rest Days Submitted',
          format('%s rest day(s) requested (%s → %s). Awaiting admin approval.',
                 n, to_char(want[1], 'Mon DD'), to_char(want[n], 'Mon DD')),
          'rest_submitted');

  return req;
end $$;

create or replace function public.ta_review_rest_days(
  p_request_id uuid, p_decision text, p_note text default null)
returns public.ta_rest_day_requests
language plpgsql security definer set search_path = public as $$
declare
  req public.ta_rest_day_requests;
  bal public.ta_rest_balances;
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can review rest-day requests' using errcode = 'P0001';
  end if;
  if p_decision not in ('approved','denied') then
    raise exception 'decision must be approved or denied' using errcode = 'P0001';
  end if;

  select * into req from public.ta_rest_day_requests where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode = 'P0001'; end if;
  if req.status <> 'pending' then raise exception 'request already reviewed' using errcode = 'P0001'; end if;

  if p_decision = 'approved' then
    select * into bal from public.ta_rest_balances where employee_id = req.employee_id for update;
    if not found then
      insert into public.ta_rest_balances (employee_id, total_days)
      values (req.employee_id, (public.ta_cfg()).rest_days_default)
      returning * into bal;
    end if;
    -- Re-check at approval time: the balance may have moved since submission.
    if req.days_count > bal.remaining_days then
      raise exception 'Cannot approve: this employee has % rest day(s) remaining but the request is for %.',
        bal.remaining_days, req.days_count using errcode = 'P0001';
    end if;

    update public.ta_rest_balances
       set used_days = used_days + req.days_count, updated_at = now()
     where employee_id = req.employee_id
     returning * into bal;

    update public.ta_rest_day_requests
       set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(),
           admin_note = p_note, balance_after = bal.remaining_days
     where id = p_request_id
     returning * into req;

    insert into public.ta_notifications (employee_id, title, message, type)
    values (req.employee_id, 'Rest Days Approved',
            format('%s rest day(s) approved. You have %s rest day(s) left.', req.days_count, bal.remaining_days),
            'rest_approved');
  else
    update public.ta_rest_day_requests
       set status = 'denied', reviewed_by = auth.uid(), reviewed_at = now(), admin_note = p_note
     where id = p_request_id
     returning * into req;

    insert into public.ta_notifications (employee_id, title, message, type)
    values (req.employee_id, 'Rest Days Denied',
            format('Your request for %s rest day(s) was denied.%s', req.days_count,
                   case when p_note is null or p_note = '' then '' else ' Note: ' || p_note end),
            'rest_denied');
  end if;

  return req;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ADMIN CONFIG RPCs
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ta_set_geofence(
  p_radius integer,
  p_lat double precision default null,
  p_lng double precision default null,
  p_enabled boolean default null,
  p_max_accuracy integer default null)
returns public.ta_settings language plpgsql security definer set search_path = public as $$
declare s public.ta_settings;
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can change attendance settings' using errcode = 'P0001';
  end if;
  if p_radius is null or p_radius < 100 or p_radius > 200 then
    raise exception 'The geofence radius must be between 100 and 200 metres.' using errcode = 'P0001';
  end if;

  update public.ta_settings
     set geofence_radius_m = p_radius,
         geofence_lat      = coalesce(p_lat, geofence_lat),
         geofence_lng      = coalesce(p_lng, geofence_lng),
         geofence_enabled  = coalesce(p_enabled, geofence_enabled),
         max_accuracy_m    = coalesce(p_max_accuracy, max_accuracy_m),
         updated_by        = auth.uid(),
         updated_at        = now()
   where id = true
   returning * into s;
  return s;
end $$;

create or replace function public.ta_set_rest_balance(p_employee uuid, p_total integer)
returns public.ta_rest_balances language plpgsql security definer set search_path = public as $$
declare b public.ta_rest_balances;
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can change rest-day balances' using errcode = 'P0001';
  end if;
  if p_total is null or p_total < 0 then
    raise exception 'Total rest days must be 0 or more.' using errcode = 'P0001';
  end if;

  select * into b from public.ta_rest_balances where employee_id = p_employee for update;
  if found and p_total < b.used_days then
    raise exception 'That employee has already used % rest day(s) — the total cannot be lower.', b.used_days
      using errcode = 'P0001';
  end if;

  insert into public.ta_rest_balances (employee_id, total_days)
  values (p_employee, p_total)
  on conflict (employee_id) do update set total_days = excluded.total_days, updated_at = now()
  returning * into b;

  return b;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. PROVISIONING — rest balance for new and existing users
-- ─────────────────────────────────────────────────────────────────────────────
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

  return new;
end $$;

-- Backfill everyone who already exists.
insert into public.ta_rest_balances (employee_id, total_days)
select p.id, coalesce((select rest_days_default from public.ta_settings where id = true), 4)
from public.ta_profiles p
on conflict (employee_id) do nothing;

-- ============================================================================
--  9. ROW LEVEL SECURITY
--     New tables: employees get SELECT on their own rows and NOTHING else.
--     Every write goes through the SECURITY DEFINER RPCs above, so a crafted
--     PostgREST call cannot skip a business rule.
-- ============================================================================
alter table public.ta_settings                enable row level security;
alter table public.ta_weekend_change_requests enable row level security;
alter table public.ta_rest_balances           enable row level security;
alter table public.ta_rest_day_requests       enable row level security;
alter table public.ta_geo_attempts            enable row level security;

-- settings: everyone reads (the app needs the centre + radius), admins write
drop policy if exists ta_set_sel on public.ta_settings;
create policy ta_set_sel on public.ta_settings for select to authenticated using (true);
drop policy if exists ta_set_upd on public.ta_settings;
create policy ta_set_upd on public.ta_settings for update to authenticated
  using (public.ta_is_admin()) with check (public.ta_is_admin());

-- weekend change requests: read own (or all, if admin); no direct writes at all
drop policy if exists ta_wcr_sel on public.ta_weekend_change_requests;
create policy ta_wcr_sel on public.ta_weekend_change_requests for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin());

-- rest balances
drop policy if exists ta_rbal_sel on public.ta_rest_balances;
create policy ta_rbal_sel on public.ta_rest_balances for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin());

-- rest day requests
drop policy if exists ta_rdr_sel on public.ta_rest_day_requests;
create policy ta_rdr_sel on public.ta_rest_day_requests for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin());

-- geofence attempt log
drop policy if exists ta_geo_sel on public.ta_geo_attempts;
create policy ta_geo_sel on public.ta_geo_attempts for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin());

-- ── ATTENDANCE: employees may no longer INSERT/UPDATE directly. ─────────────
--  This is what makes the geofence un-bypassable: the only way an employee can
--  create or close an attendance row is ta_clock_in / ta_clock_out, which
--  validate the location server-side. Admins keep direct access for corrections.
drop policy if exists ta_att_ins on public.ta_attendance;
create policy ta_att_ins on public.ta_attendance for insert to authenticated
  with check (public.ta_is_admin());
drop policy if exists ta_att_upd on public.ta_attendance;
create policy ta_att_upd on public.ta_attendance for update to authenticated
  using (public.ta_is_admin()) with check (public.ta_is_admin());

-- ============================================================================
--  10. GRANTS
-- ============================================================================
grant select on
  public.ta_settings, public.ta_weekend_change_requests,
  public.ta_rest_balances, public.ta_rest_day_requests, public.ta_geo_attempts
to authenticated;
grant update on public.ta_settings to authenticated;   -- gated by RLS (admins only)

grant execute on function public.ta_cfg()                                   to authenticated;
grant execute on function public.ta_distance_m(double precision, double precision, double precision, double precision) to authenticated;
grant execute on function public.ta_days_label(smallint[])                  to authenticated;
grant execute on function public.ta_weekend_used(uuid)                      to authenticated;
grant execute on function public.ta_rest_pending_days(uuid)                 to authenticated;
grant execute on function public.ta_rest_available(uuid)                    to authenticated;
grant execute on function public.ta_clock_in(double precision, double precision, double precision)  to authenticated;
grant execute on function public.ta_clock_out(double precision, double precision, double precision) to authenticated;
grant execute on function public.ta_request_weekend_change(smallint[], text) to authenticated;
grant execute on function public.ta_review_weekend_change(uuid, text, text)  to authenticated;
grant execute on function public.ta_request_rest_days(date[], text)          to authenticated;
grant execute on function public.ta_review_rest_days(uuid, text, text)       to authenticated;
grant execute on function public.ta_set_geofence(integer, double precision, double precision, boolean, integer) to authenticated;
grant execute on function public.ta_set_rest_balance(uuid, integer)          to authenticated;

-- ta_geo_eval is an internal helper — the clock RPCs call it as the function
-- owner, so it never needs to be reachable from the API.
revoke execute on function public.ta_geo_eval(double precision, double precision, double precision)
  from public, anon, authenticated;

-- An older revision of this file shipped ta_geo_check(); drop it if present so
-- re-running the migration leaves no dead, un-revoked entry point behind.
drop function if exists public.ta_geo_check(text, double precision, double precision, double precision);

-- ============================================================================
--  11. REALTIME (optional)
-- ============================================================================
do $$ begin
  alter publication supabase_realtime add table public.ta_weekend_change_requests;
exception when duplicate_object then null; when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.ta_rest_day_requests;
exception when duplicate_object then null; when others then null; end $$;

-- ============================================================================
--  DONE. Sanity checks:
--    select geofence_lat, geofence_lng, geofence_radius_m, rest_days_default
--      from public.ta_settings;
--    select round(public.ta_distance_m(29.979897570225, 31.357097369334436,
--                                      29.979897570225, 31.357097369334436)) as should_be_0;
--    select round(public.ta_distance_m(29.979897570225, 31.357097369334436,
--                                      29.981250000000, 31.357097369334436)) as approx_150;
-- ============================================================================
