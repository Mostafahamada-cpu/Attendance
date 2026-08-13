-- ============================================================================
--  RingRoad — Attendance & Time-Off App :: DATABASE SCHEMA
--  ---------------------------------------------------------------------------
--  Fully self-contained and ISOLATED from the existing RingRoads platform.
--  Every object is namespaced `ta_` (Time & Attendance) so it can run safely on
--  a brand-new Supabase project OR on the existing platform project WITHOUT
--  touching, renaming, or breaking any existing table, policy, or function.
--
--  Run this ONCE in the Supabase SQL editor (Dashboard → SQL → New query).
--  It is idempotent — safe to re-run.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. ENUMS
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  create type ta_role      as enum ('employee', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type ta_leave_type as enum ('casual', 'medical', 'planned');
exception when duplicate_object then null; end $$;

do $$ begin
  create type ta_leave_status as enum ('pending', 'approved', 'denied');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. PROFILES  (1:1 with auth.users)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ta_profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default 'New Employee',
  email       text,
  avatar_url  text,
  role        ta_role not null default 'employee',
  department  text default 'General',
  position    text default 'Employee',
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ATTENDANCE  (one record per employee per work day)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ta_attendance (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.ta_profiles(id) on delete cascade,
  work_date     date not null default current_date,
  clock_in      timestamptz,
  clock_out     timestamptz,
  total_minutes integer not null default 0,
  status        text not null default 'working' check (status in ('working','completed')),
  created_at    timestamptz not null default now(),
  unique (employee_id, work_date)               -- blocks duplicate clock-ins
);
create index if not exists idx_ta_att_emp  on public.ta_attendance(employee_id);
create index if not exists idx_ta_att_date on public.ta_attendance(work_date);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. LEAVE BALANCES  (one row per employee per leave type)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ta_leave_balances (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.ta_profiles(id) on delete cascade,
  leave_type   ta_leave_type not null,
  total_days   integer not null default 0,
  used_days    integer not null default 0,
  remaining_days integer generated always as (total_days - used_days) stored,
  unique (employee_id, leave_type)
);
create index if not exists idx_ta_bal_emp on public.ta_leave_balances(employee_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. LEAVE REQUESTS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ta_leave_requests (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.ta_profiles(id) on delete cascade,
  leave_type   ta_leave_type not null,
  start_date   date not null,
  end_date     date not null,
  days         integer not null,
  reason       text,
  status       ta_leave_status not null default 'pending',
  reviewed_by  uuid references public.ta_profiles(id),
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now(),
  check (end_date >= start_date),
  check (days > 0)
);
create index if not exists idx_ta_req_emp    on public.ta_leave_requests(employee_id);
create index if not exists idx_ta_req_status on public.ta_leave_requests(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. WEEKLY OFF DAYS  (day_of_week: 0=Sun … 6=Sat, JS getDay convention)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ta_weekly_off_days (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.ta_profiles(id) on delete cascade,
  day_of_week  integer not null check (day_of_week between 0 and 6),
  unique (employee_id, day_of_week)
);
create index if not exists idx_ta_off_emp on public.ta_weekly_off_days(employee_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. NOTIFICATIONS
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ta_notifications (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.ta_profiles(id) on delete cascade,
  title        text not null,
  message      text,
  type         text not null default 'info',   -- info | leave_approved | leave_denied | leave_submitted | reminder
  is_read      boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists idx_ta_notif_emp on public.ta_notifications(employee_id);

-- ============================================================================
--  HELPER FUNCTIONS
-- ============================================================================
-- Current user's role, read from ta_profiles. SECURITY DEFINER so RLS policies
-- can call it without recursively triggering ta_profiles' own policies.
create or replace function public.ta_my_role()
returns ta_role language sql stable security definer set search_path = public as $$
  select role from public.ta_profiles where id = auth.uid();
$$;

create or replace function public.ta_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.ta_profiles where id = auth.uid()), false);
$$;

-- Auto-provision a ta_profiles row + default balances + notification whenever a
-- new auth user is created. Default annual allotment: 12 casual / 8 medical /
-- 5 planned (25 total, matching the reference numbers). Adjust as needed.
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

  return new;
end $$;

drop trigger if exists ta_on_auth_user_created on auth.users;
create trigger ta_on_auth_user_created
  after insert on auth.users
  for each row execute function public.ta_handle_new_user();

-- ── ADMIN: review a leave request atomically ────────────────────────────────
-- Approve  → status=approved, add days to used_days, notify employee.
-- Deny     → status=denied, no balance change, notify employee.
-- SECURITY DEFINER + internal admin check = safe privileged operation.
create or replace function public.ta_review_leave(p_request_id uuid, p_decision text)
returns public.ta_leave_requests language plpgsql security definer set search_path = public as $$
declare
  r public.ta_leave_requests;
begin
  if not public.ta_is_admin() then
    raise exception 'Only admins can review leave requests';
  end if;
  if p_decision not in ('approved','denied') then
    raise exception 'decision must be approved or denied';
  end if;

  select * into r from public.ta_leave_requests where id = p_request_id for update;
  if not found then raise exception 'request not found'; end if;
  if r.status <> 'pending' then raise exception 'request already reviewed'; end if;

  update public.ta_leave_requests
    set status = p_decision::ta_leave_status, reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_request_id
    returning * into r;

  if p_decision = 'approved' then
    update public.ta_leave_balances
      set used_days = used_days + r.days
      where employee_id = r.employee_id and leave_type = r.leave_type;

    insert into public.ta_notifications (employee_id, title, message, type)
    values (r.employee_id, 'Leave Approved',
            format('Your %s leave (%s → %s, %s day(s)) was approved.', r.leave_type, r.start_date, r.end_date, r.days),
            'leave_approved');
  else
    insert into public.ta_notifications (employee_id, title, message, type)
    values (r.employee_id, 'Leave Denied',
            format('Your %s leave (%s → %s) was denied.', r.leave_type, r.start_date, r.end_date),
            'leave_denied');
  end if;

  return r;
end $$;

-- ============================================================================
--  ROW LEVEL SECURITY
--  Rule of thumb: employees see/write ONLY their own rows; admins see all.
-- ============================================================================
alter table public.ta_profiles       enable row level security;
alter table public.ta_attendance     enable row level security;
alter table public.ta_leave_balances enable row level security;
alter table public.ta_leave_requests enable row level security;
alter table public.ta_weekly_off_days enable row level security;
alter table public.ta_notifications  enable row level security;

-- ── profiles ────────────────────────────────────────────────────────────────
drop policy if exists ta_prof_sel on public.ta_profiles;
create policy ta_prof_sel on public.ta_profiles for select to authenticated
  using (id = auth.uid() or public.ta_is_admin());
drop policy if exists ta_prof_upd on public.ta_profiles;
create policy ta_prof_upd on public.ta_profiles for update to authenticated
  using (id = auth.uid() or public.ta_is_admin())
  with check (id = auth.uid() or public.ta_is_admin());
drop policy if exists ta_prof_ins on public.ta_profiles;
create policy ta_prof_ins on public.ta_profiles for insert to authenticated
  with check (id = auth.uid() or public.ta_is_admin());

-- ── attendance ──────────────────────────────────────────────────────────────
drop policy if exists ta_att_sel on public.ta_attendance;
create policy ta_att_sel on public.ta_attendance for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin());
drop policy if exists ta_att_ins on public.ta_attendance;
create policy ta_att_ins on public.ta_attendance for insert to authenticated
  with check (employee_id = auth.uid());
drop policy if exists ta_att_upd on public.ta_attendance;
create policy ta_att_upd on public.ta_attendance for update to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin())
  with check (employee_id = auth.uid() or public.ta_is_admin());

-- ── leave balances ──────────────────────────────────────────────────────────
drop policy if exists ta_bal_sel on public.ta_leave_balances;
create policy ta_bal_sel on public.ta_leave_balances for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin());
drop policy if exists ta_bal_upd on public.ta_leave_balances;
create policy ta_bal_upd on public.ta_leave_balances for update to authenticated
  using (public.ta_is_admin()) with check (public.ta_is_admin());
drop policy if exists ta_bal_ins on public.ta_leave_balances;
create policy ta_bal_ins on public.ta_leave_balances for insert to authenticated
  with check (public.ta_is_admin());

-- ── leave requests ──────────────────────────────────────────────────────────
drop policy if exists ta_req_sel on public.ta_leave_requests;
create policy ta_req_sel on public.ta_leave_requests for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin());
drop policy if exists ta_req_ins on public.ta_leave_requests;
create policy ta_req_ins on public.ta_leave_requests for insert to authenticated
  with check (employee_id = auth.uid());     -- employees create their own requests
drop policy if exists ta_req_upd on public.ta_leave_requests;
create policy ta_req_upd on public.ta_leave_requests for update to authenticated
  using (public.ta_is_admin()) with check (public.ta_is_admin());  -- review via RPC/admin

-- ── weekly off days ─────────────────────────────────────────────────────────
drop policy if exists ta_off_sel on public.ta_weekly_off_days;
create policy ta_off_sel on public.ta_weekly_off_days for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin());
drop policy if exists ta_off_all on public.ta_weekly_off_days;
create policy ta_off_all on public.ta_weekly_off_days for all to authenticated
  using (public.ta_is_admin()) with check (public.ta_is_admin());

-- ── notifications ───────────────────────────────────────────────────────────
drop policy if exists ta_notif_sel on public.ta_notifications;
create policy ta_notif_sel on public.ta_notifications for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin());
drop policy if exists ta_notif_upd on public.ta_notifications;
create policy ta_notif_upd on public.ta_notifications for update to authenticated
  using (employee_id = auth.uid()) with check (employee_id = auth.uid());  -- mark read
drop policy if exists ta_notif_ins on public.ta_notifications;
create policy ta_notif_ins on public.ta_notifications for insert to authenticated
  with check (public.ta_is_admin() or employee_id = auth.uid());

-- ============================================================================
--  GRANTS  (REQUIRED — RLS gates rows, but the role still needs table access)
--  Without these, the `authenticated` role gets Postgres 42501 "permission
--  denied for table" and PostgREST returns 401. RLS stays ON and is the real
--  gate; `anon` is intentionally NOT granted (these tables need a session).
-- ============================================================================
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.ta_profiles, public.ta_attendance, public.ta_leave_balances,
  public.ta_leave_requests, public.ta_weekly_off_days, public.ta_notifications
to authenticated;
grant execute on function public.ta_review_leave(uuid, text) to authenticated;

-- ============================================================================
--  REALTIME  (optional — lets the admin "Who's In" & employee notifications
--  update live if you switch the client to supabase-js websockets)
-- ============================================================================
do $$ begin
  alter publication supabase_realtime add table public.ta_attendance;
exception when duplicate_object then null; when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.ta_leave_requests;
exception when duplicate_object then null; when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.ta_notifications;
exception when duplicate_object then null; when others then null; end $$;

-- ============================================================================
--  DONE. Next: create auth users (Dashboard → Authentication → Add user, or
--  let people self-sign-up), then run db/seed.sql to set roles / demo data.
-- ============================================================================
