-- ============================================================================
--  RingRoad Attendance — SEED / ROLE ALIGNMENT (run AFTER schema.sql)
--  ---------------------------------------------------------------------------
--  Auth users must exist first. Create them in:
--    Supabase Dashboard → Authentication → Users → "Add user"
--  (tick "Auto Confirm User" so they can log in immediately), OR let them
--  self sign-up from the app's login screen.
--
--  The trigger ta_handle_new_user() already created a profile + default leave
--  balances for each. This script just promotes admins, sets departments, and
--  seeds weekly off-days. It matches by email and is a no-op for anyone who
--  doesn't exist yet — safe to run repeatedly.
--  >>> EDIT the emails below to the ones you actually created. <<<
-- ============================================================================

-- 1. Roles -------------------------------------------------------------------
update public.ta_profiles set role = 'admin',
       department = 'Management', position = 'Manager'
  where lower(email) = 'admin@ringroad.re';

update public.ta_profiles set role = 'employee',
       department = 'Sales', position = 'Sales Agent'
  where lower(email) in ('employee1@ringroad.re', 'employee2@ringroad.re');

-- 2. Nicer display names (optional) ------------------------------------------
update public.ta_profiles set full_name = 'Admin Manager'  where lower(email) = 'admin@ringroad.re';
update public.ta_profiles set full_name = 'Ahmed Ali'      where lower(email) = 'employee1@ringroad.re';
update public.ta_profiles set full_name = 'Sara Youssef'   where lower(email) = 'employee2@ringroad.re';

-- 3. Default weekly off-days (Fri=5, Sat=6) for everyone who has none ---------
insert into public.ta_weekly_off_days (employee_id, day_of_week)
select p.id, d.dow
from public.ta_profiles p
cross join (values (5),(6)) as d(dow)
where not exists (
  select 1 from public.ta_weekly_off_days w where w.employee_id = p.id
)
on conflict (employee_id, day_of_week) do nothing;

-- 4. (Optional) top up an employee's planned balance to demo different numbers
-- update public.ta_leave_balances set total_days = 25
--   where leave_type = 'planned'
--     and employee_id = (select id from public.ta_profiles where lower(email)='employee1@ringroad.re');
