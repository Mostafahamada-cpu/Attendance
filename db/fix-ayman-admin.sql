-- ============================================================================
--  RingRoad Attendance — MAKE AYMAN MADBOULY AN ACTIVE ADMIN
--  ---------------------------------------------------------------------------
--  Run this in the Supabase SQL Editor. It is small, self-contained and
--  idempotent, so it can be run on its own and re-run safely.
--
--    Email : ayman.madbouly@ringroad.re
--    Role  : admin
--
--  WHAT IT GUARANTEES
--    1. The auth account EXISTS. If it is missing it is created with the
--       temporary password from Attendance-Credentials.pdf. If it already
--       exists the account is REUSED and its PASSWORD IS NOT TOUCHED.
--    2. The account is ACTIVE and can log in: email confirmed, not banned, and
--       carrying the `email` identity row GoTrue needs for password sign-in.
--    3. ta_profiles.role = 'admin', so ta_is_admin() — the function every RLS
--       policy and admin RPC consults — returns true for him, and the frontend
--       route guard sends him to the Admin Dashboard.
--    4. He has leave balances and a rest-day balance like everybody else.
--
--  NO DUPLICATES. The auth account is matched on lower(email) and only inserted
--  WHERE NOT EXISTS; the profile is an upsert on the primary key. Re-running
--  this changes nothing the second time.
--
--  NOTE: passwords live only in auth.users.encrypted_password, hashed by
--  Supabase Auth (bcrypt). This script never writes a password anywhere else
--  and never stores one in plain text.
-- ============================================================================

set search_path = public, extensions;   -- pgcrypto (crypt/gen_salt) is in extensions

-- ─────────────────────────────────────────────────────────────────────────────
--  1. Create the account only if it is genuinely missing.
-- ─────────────────────────────────────────────────────────────────────────────
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
  'ayman.madbouly@ringroad.re', crypt('L9@+_34Qf_y$y', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', 'Ayman Madbouly', 'role', 'admin'),
  now(), now(), '', '', '', ''
where not exists (
  select 1 from auth.users where lower(email) = 'ayman.madbouly@ringroad.re'
);

-- ─────────────────────────────────────────────────────────────────────────────
--  2. Make sure the existing account is actually usable.
--     An unconfirmed or banned account fails login with a message that looks
--     nothing like "you are not an admin", so rule it out here.
--     `banned_until` and `deleted_at` only exist on newer GoTrue versions.
-- ─────────────────────────────────────────────────────────────────────────────
update auth.users
   set email_confirmed_at = coalesce(email_confirmed_at, now()),
       updated_at = now()
 where lower(email) = 'ayman.madbouly@ringroad.re';

do $$ begin
  update auth.users set banned_until = null
   where lower(email) = 'ayman.madbouly@ringroad.re' and banned_until is not null;
exception when undefined_column then
  raise notice 'auth.users.banned_until not present on this GoTrue version — skipped.';
end $$;

do $$ begin
  update auth.users set deleted_at = null
   where lower(email) = 'ayman.madbouly@ringroad.re' and deleted_at is not null;
exception when undefined_column then
  raise notice 'auth.users.deleted_at not present on this GoTrue version — skipped.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
--  3. Email identity — without it, password sign-in fails even though the row
--     in auth.users looks perfectly fine.
-- ─────────────────────────────────────────────────────────────────────────────
insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select u.id::text, u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
       'email', now(), now(), now()
from auth.users u
where lower(u.email) = 'ayman.madbouly@ringroad.re'
  and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');

-- ─────────────────────────────────────────────────────────────────────────────
--  4. THE ROLE. This is the line that makes him an admin everywhere:
--     ta_is_admin() reads ta_profiles.role, and every admin RLS policy and
--     SECURITY DEFINER RPC (including ta_set_leave_balance) calls ta_is_admin().
--
--     The v3 privilege-guard trigger blocks non-admins from changing a role,
--     but exempts sessions with no JWT — which is exactly what the SQL Editor
--     is — so this update is allowed.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.ta_profiles (id, email, full_name, role, department, position)
select u.id, u.email, 'Ayman Madbouly', 'admin'::ta_role, 'Management', 'Management'
from auth.users u
where lower(u.email) = 'ayman.madbouly@ringroad.re'
on conflict (id) do update
  set role       = 'admin'::ta_role,
      full_name  = excluded.full_name,
      department = excluded.department,
      position   = excluded.position,
      email      = excluded.email;

-- ─────────────────────────────────────────────────────────────────────────────
--  5. Balances, so he appears complete on the Vacation Balances screen.
--     DO NOTHING on conflict — never overwrite a total an admin already set.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.ta_leave_balances (employee_id, leave_type, total_days)
select p.id, t.lt, t.days
from public.ta_profiles p
cross join (values ('casual'::ta_leave_type, 12),
                   ('medical'::ta_leave_type, 8),
                   ('planned'::ta_leave_type, 5)) as t(lt, days)
where lower(p.email) = 'ayman.madbouly@ringroad.re'
on conflict (employee_id, leave_type) do nothing;

do $$ begin
  insert into public.ta_rest_balances (employee_id, total_days)
  select p.id, coalesce((select rest_days_default from public.ta_settings where id = true), 4)
  from public.ta_profiles p
  where lower(p.email) = 'ayman.madbouly@ringroad.re'
  on conflict (employee_id) do nothing;
exception when undefined_table then
  raise notice 'ta_rest_balances not found — run db/schema-v2.sql first.';
end $$;

-- ============================================================================
--  VERIFY — every column below must read OK / true.
-- ============================================================================
select
  p.full_name,
  p.email,
  p.role                                                as role_must_be_admin,
  (p.role = 'admin')                                    as is_admin_ok,
  (u.email_confirmed_at is not null)                    as email_confirmed_ok,
  exists (select 1 from auth.identities i
           where i.user_id = u.id and i.provider = 'email') as can_password_login_ok,
  (u.encrypted_password is not null)                    as has_password_ok,
  (select count(*) from public.ta_leave_balances b
    where b.employee_id = p.id)                         as balance_rows_expect_3
from public.ta_profiles p
join auth.users u on u.id = p.id
where lower(p.email) = 'ayman.madbouly@ringroad.re';

--  Expect EXACTLY ONE row above. Zero means the account was not created (check
--  for an error in step 1); more than one means a duplicate already existed
--  before this script ran — this query lists them so you can remove the spare
--  in Authentication → Users:
select u.id, u.email, u.created_at, u.last_sign_in_at
from auth.users u
where lower(u.email) = 'ayman.madbouly@ringroad.re'
order by u.created_at;

--  Orphaned profile rows carrying his email but pointing at a different auth
--  user. Expect 0 rows. (Reported, not deleted — deleting a profile cascades
--  to that person's attendance and leave history.)
select p.id as profile_id, p.email, p.role
from public.ta_profiles p
where lower(p.email) = 'ayman.madbouly@ringroad.re'
  and not exists (select 1 from auth.users u where u.id = p.id);

-- ============================================================================
--  Every admin on the project, so you can confirm the full list at a glance:
--    select full_name, email, role from public.ta_profiles
--     where role = 'admin' order by full_name;
--
--  If he still cannot sign in after this, the password is the remaining
--  variable — reset it from Authentication → Users in the Supabase dashboard,
--  or have him use "Forgot password?" on the login screen. This script
--  deliberately does not reset an existing password.
-- ============================================================================
