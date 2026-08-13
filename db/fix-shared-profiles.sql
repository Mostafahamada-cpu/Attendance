-- ============================================================================
--  RingRoad Attendance — FIX: backfill profiles for existing users
--  ---------------------------------------------------------------------------
--  Run in the Supabase SQL Editor on the EXISTING shared RingRoad project.
--
--  WHY: schema.sql already ran (the ta_* tables exist), but the profile trigger
--  only fires for NEW sign-ups — so users who existed beforehand have no
--  ta_profiles row and the app shows "no attendance profile yet". This backfills
--  them, (re)asserts the trigger for future sign-ups, and assigns roles.
--
--  IMPACT ON RINGROAD: NONE. This only creates/updates rows in ta_* tables and
--  (re)creates the ta_* trigger/functions. It never modifies RingRoad's
--  profiles/attendance/teams/deals/clients (etc.), and never changes any
--  auth.users row or password. auth.users is READ to backfill. Idempotent.
-- ============================================================================

set search_path = public, extensions;

-- 1. (Re)assert the helper functions + auto-provision trigger (idempotent, and
--    guarantees every FUTURE sign-up gets a profile automatically). This adds
--    only the ta_* trigger; RingRoad's own auth trigger is left in place.
create or replace function public.ta_my_role()
returns ta_role language sql stable security definer set search_path = public as $$
  select role from public.ta_profiles where id = auth.uid();
$$;

create or replace function public.ta_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.ta_profiles where id = auth.uid()), false);
$$;

create or replace function public.ta_handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.ta_profiles (id, email, full_name, role)
  values (
    new.id, new.email,
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

-- 2. BACKFILL: give every existing auth user a ta_profiles row (default employee).
insert into public.ta_profiles (id, email, full_name, role)
select u.id, u.email,
       coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)),
       'employee'
from auth.users u
on conflict (id) do nothing;

-- 3. BACKFILL default leave balances (12 casual / 8 medical / 5 planned).
insert into public.ta_leave_balances (employee_id, leave_type, total_days)
select p.id, t.lt, t.days
from public.ta_profiles p
cross join (values ('casual'::ta_leave_type,12),('medical'::ta_leave_type,8),('planned'::ta_leave_type,5)) as t(lt,days)
on conflict (employee_id, leave_type) do nothing;

-- 4. ROLES + departments for the known roster (idempotent; no-op for others).
--    Admins = Mohamed Ayman + Ayman Madbouly only; everyone else = employee.
update public.ta_profiles p
set role       = r.app_role::ta_role,
    department = r.department,
    position   = r.position,
    full_name  = r.full_name
from (values
  ('omar@ringroad.re', 'employee', 'TeleSales', 'TeleSales Agent', 'Omar Mahmoud'),
  ('kareem@ringroad.re', 'employee', 'TeleSales', 'TeleSales Agent', 'Kareem'),
  ('mayar@ringroad.re', 'employee', 'TeleSales', 'TeleSales Agent', 'Mayar'),
  ('shefaa@ringroad.re', 'employee', 'TeleSales', 'TeleSales Agent', 'Shefaa'),
  ('hasnaa@ringroad.re', 'employee', 'TeleSales', 'TeleSales Agent', 'Hasnaa'),
  ('mr.sayed@ringroad.re', 'employee', 'TeleSales', 'Team Leader', 'Mr.Sayed'),
  ('hend@ringroad.re', 'employee', 'TeleSales', 'TeleSales Agent', 'Hend'),
  ('mohamed.rouq@ringroad.re', 'employee', 'TeleSales', 'TeleSales Agent', 'Mohamed Rouq'),
  ('mohamed.atta@ringroad.re', 'employee', 'TeleSales', 'TeleSales Agent', 'Mohamed Atta'),
  ('mohamed.ayman@ringroad.re', 'admin', 'Management', 'Administrator', 'Mohamed Ayman'),
  ('ayman.madbouly@ringroad.re', 'admin', 'Management', 'Management', 'Ayman Madbouly'),
  ('fatma@ringroad.re', 'employee', 'TeleSales', 'TeleSales Agent', 'Fatma'),
  ('nada@ringroad.re', 'employee', 'TeleSales', 'TeleSales Agent', 'Nada'),
  ('abobakr@ringroad.re', 'employee', 'TeleSales', 'TeleSales Agent', 'AboBakr'),
  ('ahmed.shaaban@ringroad.re', 'employee', 'Engineering', 'Engineer', 'Ahmed Shaaban'),
  ('nada.eng@ringroad.re', 'employee', 'Engineering', 'Engineer', 'Nada'),
  ('aya@ringroad.re', 'employee', 'Engineering', 'Engineer', 'Aya'),
  ('eslam@ringroad.re', 'employee', 'Engineering', 'Engineer', 'Eslam')
) as r(email, app_role, department, position, full_name)
where lower(p.email) = lower(r.email);

-- To promote any OTHER email to admin (e.g. your own test login), uncomment:
-- update public.ta_profiles set role='admin' where lower(email) = lower('you@ringroad.re');

-- 5. VERIFY --------------------------------------------------------------------
select (select count(*) from auth.users)            as auth_users,
       (select count(*) from public.ta_profiles)    as ta_profiles,
       (select count(*) from public.ta_profiles where role='admin') as admins;

select email, full_name, role as access_tier, department, position
from public.ta_profiles
order by (role='admin') desc, department, email;
