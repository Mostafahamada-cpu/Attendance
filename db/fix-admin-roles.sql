-- ============================================================================
--  RingRoad Attendance — EXACTLY TWO ADMINS
--  ---------------------------------------------------------------------------
--  Run this in the Supabase SQL Editor. It is the AUTHORITATIVE script for who
--  is an administrator, and it is the LAST one to run:
--
--      schema.sql → schema-v2 → schema-v3 → schema-v4
--        → provision-users-v2.sql → fix-ayman-admin.sql → THIS FILE
--
--  END STATE, guaranteed:
--
--      Ayman Madbouly   ayman.madbouly@ringroad.re    admin
--      Mohamed Ayman    mohamed.ayman@ringroad.re     admin
--      ── and nobody else ──
--
--  Everyone else is `employee`, whatever their job title. Mr Sayed in
--  particular is put back to the role his original provisioning data gives him
--  (db/provision-users.sql and db/fix-shared-profiles.sql both say
--  employee / TeleSales / Team Leader). No new Sayed account is created and no
--  account is deleted — only the `role` column moves.
--
--  WHY THIS IS THE ONLY LEVER
--  --------------------------
--  `ta_is_admin()` is defined as `select role = 'admin' from ta_profiles where
--  id = auth.uid()`. Every admin RLS policy and every admin RPC — including
--  ta_set_leave_balance() and ta_review_leave() — calls it, and the frontend
--  route guard reads the very same `ta_profiles.role` off the profile it loads
--  at boot. So setting this column IS setting admin access, in the database and
--  in the UI at once. There is no second place to change and no way for the two
--  to disagree.
--
--  IDEMPOTENT. It converges on the end state from wherever you are, and the
--  second run reports zero changes. Passwords, attendance, leave, balances and
--  every other column are untouched.
-- ============================================================================

set search_path = public, extensions;   -- pgcrypto (crypt/gen_salt) is in extensions

-- ─────────────────────────────────────────────────────────────────────────────
--  THE ALLOW-LIST. This is the whole policy — to change who administers the
--  system, edit these two rows and re-run. Anyone not listed here is demoted.
-- ─────────────────────────────────────────────────────────────────────────────
drop table if exists _att_admins;
create temporary table _att_admins (
  email text primary key, full_name text, temp_password text, department text, position text
);
insert into _att_admins (email, full_name, temp_password, department, position) values
  ('ayman.madbouly@ringroad.re', 'Ayman Madbouly', 'L9@+_34Qf_y$y',  'Management', 'Management'),
  ('mohamed.ayman@ringroad.re',  'Mohamed Ayman',  '%P_d4Q9#tdRs7W4','Management', 'Administrator');

-- ─────────────────────────────────────────────────────────────────────────────
--  0. BEFORE — who holds the admin role right now.
-- ─────────────────────────────────────────────────────────────────────────────
select 'BEFORE' as stage, full_name, email, role, department, position
from public.ta_profiles
where role = 'admin'
order by full_name;

-- ─────────────────────────────────────────────────────────────────────────────
--  1. Keep ta_profiles.email in step with auth.users.email.
--     Everything below matches people by email, so a profile carrying a stale
--     address could be demoted by mistake — or worse, escape demotion. Sync it
--     from the authoritative side first.
-- ─────────────────────────────────────────────────────────────────────────────
update public.ta_profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and p.email is distinct from u.email;

-- ─────────────────────────────────────────────────────────────────────────────
--  2. The two administrators must EXIST. Created only if genuinely missing,
--     with the temporary password already published in
--     Attendance-Credentials.pdf; an existing account keeps its own password.
-- ─────────────────────────────────────────────────────────────────────────────
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
  a.email, crypt(a.temp_password, gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', a.full_name, 'role', 'admin'),
  now(), now(), '', '', '', ''
from _att_admins a
where not exists (select 1 from auth.users u where lower(u.email) = a.email);

--  …and be able to log in: confirmed, not banned, with an email identity.
update auth.users u
   set email_confirmed_at = coalesce(u.email_confirmed_at, now()), updated_at = now()
  from _att_admins a
 where lower(u.email) = a.email and u.email_confirmed_at is null;

do $$ begin
  update auth.users u set banned_until = null
    from _att_admins a where lower(u.email) = a.email and u.banned_until is not null;
exception when undefined_column then raise notice 'auth.users.banned_until not present — skipped.'; end $$;

do $$ begin
  update auth.users u set deleted_at = null
    from _att_admins a where lower(u.email) = a.email and u.deleted_at is not null;
exception when undefined_column then raise notice 'auth.users.deleted_at not present — skipped.'; end $$;

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select u.id::text, u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
       'email', now(), now(), now()
from auth.users u
join _att_admins a on lower(u.email) = a.email
where not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');

-- ─────────────────────────────────────────────────────────────────────────────
--  3. GRANT admin to the two. Upsert on the primary key, so an existing
--     profile is updated in place and no duplicate row is ever created.
--
--     The v3 privilege-guard trigger blocks non-admins from changing a role but
--     exempts sessions with no JWT — which is what the SQL Editor is — so this
--     is allowed.
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.ta_profiles (id, email, full_name, role, department, position)
select u.id, u.email, a.full_name, 'admin'::ta_role, a.department, a.position
from auth.users u
join _att_admins a on lower(u.email) = a.email
on conflict (id) do update
  set role       = 'admin'::ta_role,
      full_name  = excluded.full_name,
      department = excluded.department,
      position   = excluded.position,
      email      = excluded.email;

-- ─────────────────────────────────────────────────────────────────────────────
--  4. REVOKE admin from everybody else.
--
--     coalesce() matters: a profile with a NULL email would make
--     `lower(email) not in (…)` evaluate to NULL rather than true, and that row
--     would silently keep its admin rights. '' is never in the allow-list.
--
--     Mr Sayed is restored to his original provisioning record; anyone else
--     demoted keeps their department and job title and only loses the role.
-- ─────────────────────────────────────────────────────────────────────────────
with demoted as (
  update public.ta_profiles p
     set role = 'employee'::ta_role,
         department = case when lower(coalesce(p.email, '')) in ('sayed@ringroad.re', 'mr.sayed@ringroad.re')
                           then 'TeleSales' else p.department end,
         position   = case when lower(coalesce(p.email, '')) in ('sayed@ringroad.re', 'mr.sayed@ringroad.re')
                           then 'Team Leader' else p.position end
   where p.role = 'admin'
     and lower(coalesce(p.email, '')) not in (select email from _att_admins)
  returning p.full_name, p.email, p.department, p.position
)
select 'DEMOTED to employee' as action, full_name, email, department, position
from demoted
order by full_name;

-- ============================================================================
--  VERIFICATION — the point of the whole script.
-- ============================================================================

-- ── A. Exactly two admins. `result` must read PASS. ─────────────────────────
select
  count(*)                                    as admin_count,
  2                                           as expected,
  case when count(*) = 2 then 'PASS' else 'FAIL — see the list below' end as result
from public.ta_profiles
where role = 'admin';

-- ── B. The exact query from the requirement. Must return ONLY these two:
--       Ayman Madbouly  ·  Mohamed Ayman
select full_name, email, role
from public.ta_profiles
where role = 'admin'
order by full_name;

-- ── C. Both of the expected admins are present AND nobody else is. ──────────
--       Every column must read true.
select
  exists (select 1 from public.ta_profiles
           where role = 'admin' and lower(email) = 'ayman.madbouly@ringroad.re') as ayman_madbouly_is_admin,
  exists (select 1 from public.ta_profiles
           where role = 'admin' and lower(email) = 'mohamed.ayman@ringroad.re')  as mohamed_ayman_is_admin,
  not exists (select 1 from public.ta_profiles
               where role = 'admin'
                 and lower(coalesce(email, '')) not in
                     ('ayman.madbouly@ringroad.re', 'mohamed.ayman@ringroad.re')) as no_other_admins,
  (select count(*) from public.ta_profiles where role = 'admin') = 2              as exactly_two;

-- ── D. Mr Sayed specifically — must be an employee, on both addresses. ──────
select full_name, email, role, department, position,
       case when role = 'employee' then 'PASS — not an admin' else 'FAIL — still admin' end as result
from public.ta_profiles
where lower(coalesce(email, '')) in ('sayed@ringroad.re', 'mr.sayed@ringroad.re')
order by email;

-- ── E. The final roles of everyone this project provisions. ─────────────────
select
  full_name, email, role,
  department, position,
  case role when 'admin' then 'Admin Dashboard + all administrative functions'
            else 'Employee app only (own records; vacation balance read-only)' end as access
from public.ta_profiles
where lower(coalesce(email, '')) in (
  'ayman.madbouly@ringroad.re', 'mohamed.ayman@ringroad.re',
  'sayed@ringroad.re', 'mr.sayed@ringroad.re', 'sherif@ringroad.re',
  'omar.ayman@ringroad.re', 'eslam@ringroad.re', 'peter@ringroad.re', 'mostafa@ringroad.re')
order by (role = 'admin') desc, full_name;

-- ── F. A loud notice in the output pane, so a FAIL is hard to scroll past. ──
do $$
declare
  n      integer;
  extras text;
begin
  select count(*) into n from public.ta_profiles where role = 'admin';
  select string_agg(coalesce(full_name, '?') || ' <' || coalesce(email, 'no email') || '>', ', ')
    into extras
    from public.ta_profiles
   where role = 'admin'
     and lower(coalesce(email, '')) not in ('ayman.madbouly@ringroad.re', 'mohamed.ayman@ringroad.re');

  if n = 2 and extras is null then
    raise notice 'OK — exactly two admins: Ayman Madbouly and Mohamed Ayman.';
  else
    -- A warning, not an exception: raising here would roll back the very fix
    -- this script just applied. Read it and re-run.
    raise warning 'ADMIN CHECK FAILED — % admin(s) found. Unexpected: %', n, coalesce(extras, 'none');
  end if;
end $$;

drop table if exists _att_admins;

-- ============================================================================
--  NOTES
--   • Nothing here touches a password. Every user, admin or not, still changes
--     their own from Settings → Security → Change Password.
--   • Demoting somebody takes effect in the database immediately. The frontend
--     reads ta_profiles.role when it boots, so a user who is signed in at that
--     moment keeps the admin UI until they reload or sign in again — the
--     database refuses their admin writes either way, because ta_is_admin() is
--     evaluated per request, not per session.
--   • To re-check at any time, without changing anything:
--       select full_name, email, role from public.ta_profiles where role = 'admin';
-- ============================================================================
