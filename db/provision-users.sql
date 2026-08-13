-- ============================================================================
--  RingRoad Attendance — USER PROVISIONING  (run in the Supabase SQL Editor)
--  ---------------------------------------------------------------------------
--  Provisions the 18 Attendance users on the SHARED RingRoad project.
--
--  SAFE & IDEMPOTENT — re-runnable, and it never breaks RingRoad:
--    * Existing auth accounts are REUSED; their PASSWORD IS LEFT UNTOUCHED
--      (new users are inserted only WHERE NOT EXISTS by email).
--    * Only genuinely-missing accounts are created, with the temp password from
--      the PDF, and marked email-confirmed so they can log in immediately.
--    * Roles + departments are set for all 18 (idempotent upsert by email).
--    * No existing RingRoad row, table, or password is modified.
--
--  PREREQUISITE: run db/schema.sql first (creates the ta_* tables + trigger).
--  The final SELECT reports each account's access tier and whether it was newly
--  created (use temp password) or already existed (keep current password).
--
--  Troubleshooting: if your GoTrue version rejects the insert for a NULL
--  "*_token" column, add that column to the INSERT in step 1 with value ''.
-- ============================================================================

set search_path = public, extensions;   -- pgcrypto (crypt/gen_salt) is in extensions

-- Roster held in a temp table so it's defined exactly once. -------------------
drop table if exists _att_roster;
create temporary table _att_roster (
  email text, full_name text, temp_password text,
  app_role text, department text, position text
);
insert into _att_roster (email, full_name, temp_password, app_role, department, position) values
  ('omar@ringroad.re', 'Omar Mahmoud', 'Vivid%618!UG', 'employee', 'TeleSales', 'TeleSales Agent'),
  ('kareem@ringroad.re', 'Kareem', 'Kestrel#393$CV', 'employee', 'TeleSales', 'TeleSales Agent'),
  ('mayar@ringroad.re', 'Mayar', 'Orbit#379%NC', 'employee', 'TeleSales', 'TeleSales Agent'),
  ('shefaa@ringroad.re', 'Shefaa', 'Orbit@168&RR', 'employee', 'TeleSales', 'TeleSales Agent'),
  ('hasnaa@ringroad.re', 'Hasnaa', 'Falcon@803@NZ', 'employee', 'TeleSales', 'TeleSales Agent'),
  ('mr.sayed@ringroad.re', 'Mr.Sayed', 'Nimbus*767*SS', 'employee', 'TeleSales', 'Team Leader'),
  ('hend@ringroad.re', 'Hend', 'Pilot&507$RH', 'employee', 'TeleSales', 'TeleSales Agent'),
  ('mohamed.rouq@ringroad.re', 'Mohamed Rouq', 'Vertex!154$SS', 'employee', 'TeleSales', 'TeleSales Agent'),
  ('mohamed.atta@ringroad.re', 'Mohamed Atta', 'Basalt%234%CZ', 'employee', 'TeleSales', 'TeleSales Agent'),
  ('mohamed.ayman@ringroad.re', 'Mohamed Ayman', 'Quartz&872*AK', 'admin', 'Management', 'Administrator'),
  ('ayman.madbouly@ringroad.re', 'Ayman Madbouly', 'Zephyr!368#SD', 'admin', 'Management', 'Management'),
  ('fatma@ringroad.re', 'Fatma', 'Pilot&819&NK', 'employee', 'TeleSales', 'TeleSales Agent'),
  ('nada@ringroad.re', 'Nada', 'Nimbus%263&XT', 'employee', 'TeleSales', 'TeleSales Agent'),
  ('abobakr@ringroad.re', 'AboBakr', 'Vertex%727*TD', 'employee', 'TeleSales', 'TeleSales Agent'),
  ('ahmed.shaaban@ringroad.re', 'Ahmed Shaaban', 'Vertex*223!PG', 'employee', 'Engineering', 'Engineer'),
  ('nada.eng@ringroad.re', 'Nada', 'Onyx&707#ZK', 'employee', 'Engineering', 'Engineer'),
  ('aya@ringroad.re', 'Aya', 'Cobalt*489!YT', 'employee', 'Engineering', 'Engineer'),
  ('eslam@ringroad.re', 'Eslam', 'Zephyr&416%AQ', 'employee', 'Engineering', 'Engineer');

-- 1. Create ONLY accounts that don't already exist (existing ones untouched). --
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
  r.email, crypt(r.temp_password, gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', r.full_name, 'role', r.app_role),
  now(), now(), '', '', '', ''
from _att_roster r
where not exists (select 1 from auth.users u where lower(u.email) = lower(r.email));

-- 2. Ensure every roster user has an email identity (needed for password login).
insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select u.id::text, u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
       'email', now(), now(), now()
from auth.users u
join _att_roster r on lower(r.email) = lower(u.email)
where not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');

-- 3. Upsert ta_profiles with the correct role / department / position. ---------
insert into public.ta_profiles (id, email, full_name, role, department, position)
select u.id, u.email, r.full_name, r.app_role::ta_role, r.department, r.position
from auth.users u
join _att_roster r on lower(r.email) = lower(u.email)
on conflict (id) do update
  set full_name  = excluded.full_name,
      role       = excluded.role,
      department = excluded.department,
      position   = excluded.position,
      email      = excluded.email;

-- 4. Ensure default leave balances (12 casual / 8 medical / 5 planned). --------
insert into public.ta_leave_balances (employee_id, leave_type, total_days)
select p.id, t.lt, t.days
from public.ta_profiles p
join _att_roster r on lower(r.email) = lower(p.email)
cross join (values ('casual'::ta_leave_type,12),('medical'::ta_leave_type,8),('planned'::ta_leave_type,5)) as t(lt,days)
on conflict (employee_id, leave_type) do nothing;

-- 5. REPORT. -------------------------------------------------------------------
select
  p.full_name,
  p.position                                   as title,
  p.role                                       as access_tier,
  p.email,
  case when u.created_at > now() - interval '2 minutes'
       then 'NEW - use temp password from PDF'
       else 'EXISTING - keep current password' end as login_note
from public.ta_profiles p
join auth.users u  on u.id = p.id
join _att_roster r on lower(r.email) = lower(p.email)
order by (p.role = 'admin') desc, p.department, p.full_name;

drop table if exists _att_roster;
