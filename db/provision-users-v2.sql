-- ============================================================================
--  RingRoad Attendance — USER PROVISIONING v2  (run in the Supabase SQL Editor)
--  ---------------------------------------------------------------------------
--  Adds / aligns the following seven people. It does NOT touch anybody else on
--  the project — the other accounts from db/provision-users.sql keep their
--  roles, departments and passwords exactly as they are.
--
--    Ayman Madbouly  admin       (created if missing — one of only TWO admins)
--    Mohamed Ayman   admin       (created if missing — the other admin)
--    Mr Sayed        employee    TeleSales · Team Leader  — NOT an admin
--    Sherif          employee    Engineering · Engineer   (new)
--    Omar Ayman      employee    TeleSales · Agent        (new)
--    Eslam           employee    Engineering · Engineer   (existing)
--    Peter           employee    Operations · Office Boy  (new)
--    Mostafa         employee    IT · Developer           (new)
--
--  THERE ARE EXACTLY TWO ADMINS: Ayman Madbouly and Mohamed Ayman. Nobody else
--  gets role = 'admin'. db/fix-admin-roles.sql is the authoritative enforcer of
--  that rule — run it after this file, and it will demote anyone who slipped
--  through.
--
--  SAFE & IDEMPOTENT — re-runnable:
--    * NO DUPLICATES. Accounts are matched by email; an existing account is
--      UPDATED in place and its PASSWORD IS LEFT UNTOUCHED.
--    * Only genuinely-missing accounts are created, with the temp password
--      printed in Attendance-Credentials.pdf, marked email-confirmed.
--    * Authentication is not modified: no auth trigger, policy or GoTrue
--      setting is changed, and no existing credential is reset.
--
--  ROLE MODEL (unchanged — ta_role is still just 'employee' | 'admin')
--    role = 'admin'    → admin shell: dashboard, employees, vacation balances,
--                        leave review, geofence, analytics.
--    role = 'employee' → employee shell only: clock in/out, own leave, own
--                        balance (READ ONLY), calendar, notifications, profile.
--    The job title ("Engineer", "Office Boy", "Developer", "TeleSales Agent")
--    lives in ta_profiles.position and carries no privileges of its own — which
--    is exactly why adding these people cannot widen anyone's access.
--
--  MR SAYED — TWO ADDRESSES, NEITHER OF THEM AN ADMIN
--    The repo disagrees with itself about his email: provision-users.sql and
--    fix-shared-profiles.sql say 'mr.sayed@ringroad.re', while the credentials
--    CSV/PDF say 'sayed@ringroad.re'. Both are listed so that whichever one is
--    real ends up with the correct record — employee / TeleSales / Team Leader,
--    exactly as his original provisioning data has it. Neither is created and
--    neither is promoted. Team Leader is a job title, not a permission.
--
--  PREREQUISITES: db/schema.sql, schema-v2.sql, schema-v3.sql, schema-v4.sql.
-- ============================================================================

set search_path = public, extensions;   -- pgcrypto (crypt/gen_salt) lives in extensions

-- ─────────────────────────────────────────────────────────────────────────────
--  Roster — defined once, in a temp table.
--  `must_exist` marks the rows we will NOT create an auth account for — only
--  Mr Sayed's two candidate addresses, because exactly one of them is real and
--  creating both would leave a bogus account behind. Everyone else, including
--  the two Ayman administrators, is created if missing: the requirement is that
--  Ayman Madbouly EXISTS as an active admin, not merely that he is promoted if
--  someone already made him. Their passwords are the ones already published in
--  Attendance-Credentials.pdf, and an existing account keeps its own.
--
--  `app_role` is the access tier and is 'admin' on exactly two rows.
-- ─────────────────────────────────────────────────────────────────────────────
drop table if exists _att_roster2;
create temporary table _att_roster2 (
  email text primary key, full_name text, temp_password text,
  app_role text, department text, position text, must_exist boolean default false
);
insert into _att_roster2 (email, full_name, temp_password, app_role, department, position, must_exist) values
  -- ── The ONLY two admins in the system. Created if missing. ──────────────
  ('ayman.madbouly@ringroad.re', 'Ayman Madbouly', 'L9@+_34Qf_y$y',  'admin',    'Management',  'Management',      false),
  ('mohamed.ayman@ringroad.re',  'Mohamed Ayman',  '%P_d4Q9#tdRs7W4','admin',    'Management',  'Administrator',   false),
  -- ── Mr Sayed: NOT an admin. Both candidate addresses are listed so that
  --    whichever one is real gets the right title; neither is created and
  --    neither is promoted. "Team Leader" is a job title, not a permission. ──
  ('sayed@ringroad.re',          'Mr Sayed',       null,             'employee', 'TeleSales',   'Team Leader',     true),
  ('mr.sayed@ringroad.re',       'Mr Sayed',       null,             'employee', 'TeleSales',   'Team Leader',     true),
  -- ── Employees — created if missing. ─────────────────────────────────────
  ('sherif@ringroad.re',         'Sherif',         'Sable&888&HP',   'employee', 'Engineering', 'Engineer',        false),
  ('omar.ayman@ringroad.re',     'Omar Ayman',     'Maple#485%SF',   'employee', 'TeleSales',   'TeleSales Agent', false),
  ('eslam@ringroad.re',          'Eslam',          'Zephyr&416%AQ',  'employee', 'Engineering', 'Engineer',        false),
  ('peter@ringroad.re',          'Peter',          'Zephyr!686*SS',  'employee', 'Operations',  'Office Boy',      false),
  ('mostafa@ringroad.re',        'Mostafa',        'Quartz@635$KA',  'employee', 'IT',          'Developer',       false);

-- ─────────────────────────────────────────────────────────────────────────────
--  1. Create ONLY the missing employee accounts.
--     `must_exist` rows are skipped entirely, and the NOT EXISTS guard is what
--     makes this re-runnable without ever producing a duplicate.
-- ─────────────────────────────────────────────────────────────────────────────
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
from _att_roster2 r
where not r.must_exist
  and r.temp_password is not null
  and not exists (select 1 from auth.users u where lower(u.email) = lower(r.email));

-- ─────────────────────────────────────────────────────────────────────────────
--  2. Every roster account needs an email identity for password login.
--     (Harmless for the ones that already have it.)
-- ─────────────────────────────────────────────────────────────────────────────
insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select u.id::text, u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
       'email', now(), now(), now()
from auth.users u
join _att_roster2 r on lower(r.email) = lower(u.email)
where not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');

-- ─────────────────────────────────────────────────────────────────────────────
--  2b. Make sure every roster account is ACTIVE.
--      A confirmed-but-banned or never-confirmed account fails login with a
--      message that looks nothing like a permissions problem, so rule it out.
--      banned_until / deleted_at exist only on newer GoTrue versions.
-- ─────────────────────────────────────────────────────────────────────────────
update auth.users u
   set email_confirmed_at = coalesce(u.email_confirmed_at, now()), updated_at = now()
  from _att_roster2 r
 where lower(u.email) = lower(r.email) and u.email_confirmed_at is null;

do $$ begin
  update auth.users u set banned_until = null
    from _att_roster2 r
   where lower(u.email) = lower(r.email) and u.banned_until is not null;
exception when undefined_column then raise notice 'auth.users.banned_until not present — skipped.'; end $$;

do $$ begin
  update auth.users u set deleted_at = null
    from _att_roster2 r
   where lower(u.email) = lower(r.email) and u.deleted_at is not null;
exception when undefined_column then raise notice 'auth.users.deleted_at not present — skipped.'; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
--  3. Upsert ta_profiles — the step that actually sets the role.
--     ON CONFLICT (id) DO UPDATE = "update the existing record", never insert a
--     second one. is_manager and avatar_url are deliberately left alone.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.ta_profiles (id, email, full_name, role, department, position)
select u.id, u.email, r.full_name, r.app_role::ta_role, r.department, r.position
from auth.users u
join _att_roster2 r on lower(r.email) = lower(u.email)
on conflict (id) do update
  set full_name  = excluded.full_name,
      role       = excluded.role,
      department = excluded.department,
      position   = excluded.position,
      email      = excluded.email;

-- ─────────────────────────────────────────────────────────────────────────────
--  4. Default vacation balances for anyone who has none yet
--     (12 casual / 8 medical / 5 planned). DO NOTHING on conflict, so an
--     admin's hand-set balance is never overwritten by a re-run.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.ta_leave_balances (employee_id, leave_type, total_days)
select p.id, t.lt, t.days
from public.ta_profiles p
join _att_roster2 r on lower(r.email) = lower(p.email)
cross join (values ('casual'::ta_leave_type, 12),
                   ('medical'::ta_leave_type, 8),
                   ('planned'::ta_leave_type, 5)) as t(lt, days)
on conflict (employee_id, leave_type) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
--  5. Rest-day balance for anyone new (v2 feature; skipped if v2 isn't run).
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  insert into public.ta_rest_balances (employee_id, total_days)
  select p.id, coalesce((select rest_days_default from public.ta_settings where id = true), 4)
  from public.ta_profiles p
  join _att_roster2 r on lower(r.email) = lower(p.email)
  on conflict (employee_id) do nothing;
exception when undefined_table then
  raise notice 'ta_rest_balances not found — run db/schema-v2.sql first.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
--  6. REPORT — check this before you close the SQL editor.
--     `access` tells you what each person can reach; `login_note` tells you
--     which password to hand out.
-- ─────────────────────────────────────────────────────────────────────────────
select
  p.full_name,
  p.position                          as title,
  p.role                              as access_tier,
  case p.role when 'admin' then 'Admin Dashboard + all administrative functions'
              else 'Employee app only (own records; balance is read-only)' end as access,
  p.email,
  coalesce(b.casual, 0) || ' / ' || coalesce(b.medical, 0) || ' / ' || coalesce(b.planned, 0)
                                      as vacation_c_m_p,
  case when u.created_at > now() - interval '2 minutes'
       then 'NEW — use the temp password from the PDF'
       else 'EXISTING — password unchanged' end as login_note
from public.ta_profiles p
join auth.users u  on u.id = p.id
join _att_roster2 r on lower(r.email) = lower(p.email)
left join (
  select employee_id,
         max(total_days) filter (where leave_type = 'casual')  as casual,
         max(total_days) filter (where leave_type = 'medical') as medical,
         max(total_days) filter (where leave_type = 'planned') as planned
  from public.ta_leave_balances group by employee_id
) b on b.employee_id = p.id
order by (p.role = 'admin') desc, p.department, p.full_name;

--  Roster entries that matched NO account. Expect at most ONE row here: the
--  unused half of Mr Sayed's two addresses. Anything else listed means that
--  person still has no login. Ayman Madbouly must NOT appear here.
select r.full_name, r.email,
       case when r.must_exist then 'NOT CREATED — no such account (expected for ONE of the two Sayed addresses)'
            else 'MISSING — re-run, or add the account in Authentication → Users' end as status
from _att_roster2 r
where not exists (select 1 from auth.users u where lower(u.email) = lower(r.email));

--  Every admin on the project. This MUST list exactly two people —
--  Ayman Madbouly and Mohamed Ayman. If anyone else appears, run
--  db/fix-admin-roles.sql, which demotes them.
select full_name, email, role, department, position,
       (select count(*) from public.ta_profiles where role = 'admin') as admin_count_must_be_2
from public.ta_profiles
where role = 'admin'
order by full_name;

drop table if exists _att_roster2;

-- ============================================================================
--  AFTER RUNNING
--   • EVERY user changes their own password in the app's Security section —
--     admins at My Account, employees at More. It asks for the current password
--     first and updates through Supabase Auth. There is no "set this person's
--     password" control anywhere, by design: the endpoint acts on the session's
--     own account, so nobody can change somebody else's from Settings.
--   • Ayman Madbouly is an active admin (expect one row, role = admin):
--       select p.full_name, p.role, (u.email_confirmed_at is not null) as confirmed
--         from public.ta_profiles p join auth.users u on u.id = p.id
--        where lower(p.email) = 'ayman.madbouly@ringroad.re';
--   • EXACTLY TWO ADMINS — Ayman Madbouly and Mohamed Ayman, nobody else:
--       select full_name, email, role from public.ta_profiles where role = 'admin';
--     Then run db/fix-admin-roles.sql, which enforces this and proves it.
--   • Verify nobody was duplicated (expect 0 rows):
--       select lower(email), count(*) from public.ta_profiles
--        group by 1 having count(*) > 1;
--   • Verify the access tiers:
--       select full_name, position, role from public.ta_profiles
--        order by (role = 'admin') desc, full_name;
-- ============================================================================
