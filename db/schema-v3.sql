-- ============================================================================
--  RingRoad — Attendance & Time-Off :: SCHEMA v3  (ADDITIVE MIGRATION)
--  ---------------------------------------------------------------------------
--  Run this ONCE in the Supabase SQL editor AFTER db/schema.sql and
--  db/schema-v2.sql. Idempotent and purely additive — it never drops a table
--  or a row, and it changes no existing column's meaning.
--
--  WHAT IT ADDS — a real two-stage HR leave workflow
--  ------------------------------------------------
--   1. A MANAGER capability: ta_profiles.is_manager. A manager is an ordinary
--      employee (they still clock in) who can also review leave requests.
--      Deliberately a boolean rather than a new ta_role enum value: adding an
--      enum value cannot be used in the same transaction that adds it, which
--      makes a single-script migration fragile. This is non-breaking — every
--      existing `role = 'employee' / 'admin'` check keeps working untouched.
--
--   2. DUAL APPROVAL on ta_leave_requests. Two independent decision slots:
--        manager_decision / manager_by / manager_at / manager_note
--        admin_decision   / admin_by   / admin_at   / admin_note
--      `status` keeps its existing three values (pending / approved / denied),
--      so nothing that reads it breaks. The intermediate states the brief asks
--      for — "Waiting for Admin", "Waiting for Manager" — are DERIVED from the
--      two slots by ta_leave_stage(). Either approver may go first; the request
--      becomes `approved` only once every required slot has approved, and one
--      rejection from either makes it `denied` immediately.
--
--   3. BALANCE IS DEDUCTED ONLY ON FINAL APPROVAL. Submitting reserves nothing
--      and changes no balance. ta_leave_requests.balance_before is captured at
--      submission and balance_after is written at final approval.
--
--   4. ATTACHMENTS: an optional private Storage file per request (intended for
--      medical certificates), recorded as attachment_path + attachment_name.
--
--   5. A PRIVILEGE-ESCALATION FIX. The existing ta_profiles UPDATE policy lets
--      a user edit their own row — which also let them set their own
--      role = 'admin'. A trigger now blocks any non-admin from changing `role`
--      or `is_manager`, on their own row or anyone else's.
--
--  ENFORCEMENT: every write goes through a SECURITY DEFINER RPC. Employees
--  lose direct INSERT on ta_leave_requests and nobody can UPDATE the table
--  directly, so the balance rule cannot be sidestepped by calling PostgREST.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. MANAGER CAPABILITY
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.ta_profiles
  add column if not exists is_manager boolean not null default false;

create index if not exists idx_ta_prof_manager
  on public.ta_profiles(is_manager) where is_manager;

create or replace function public.ta_is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_manager from public.ta_profiles where id = auth.uid()), false);
$$;

-- Can the current user review leave at all?
create or replace function public.ta_is_approver()
returns boolean language sql stable security definer set search_path = public as $$
  select public.ta_is_admin() or public.ta_is_manager();
$$;

-- How many managers exist. The admin UI uses this to warn when dual approval
-- is switched on but nobody can fill the manager slot.
create or replace function public.ta_manager_count()
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from public.ta_profiles where is_manager;
$$;

-- ── Privilege guard ─────────────────────────────────────────────────────────
--  ta_prof_upd allows `id = auth.uid()`, which is right for editing your own
--  name or avatar but must never extend to granting yourself power.
create or replace function public.ta_guard_profile_privileges()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- No JWT at all = a direct database session (the Supabase SQL editor, a
  -- migration, service_role). Those must stay able to seed roles, and `anon`
  -- can't reach this table anyway — schema.sql grants it only to authenticated.
  if auth.uid() is null then
    return new;
  end if;
  if public.ta_is_admin() then
    return new;                     -- admins may change roles freely
  end if;
  if new.role is distinct from old.role then
    raise exception 'Only an admin can change a role.' using errcode = 'P0001';
  end if;
  if new.is_manager is distinct from old.is_manager then
    raise exception 'Only an admin can grant or remove manager rights.' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists ta_profiles_privilege_guard on public.ta_profiles;
create trigger ta_profiles_privilege_guard
  before update on public.ta_profiles
  for each row execute function public.ta_guard_profile_privileges();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. APPROVAL-FLOW SETTINGS
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.ta_settings
  add column if not exists require_manager_approval boolean not null default true,
  add column if not exists require_admin_approval   boolean not null default true;

-- At least one approver must always be required, or requests could never close.
do $$ begin
  alter table public.ta_settings
    add constraint ta_settings_one_approver
    check (require_manager_approval or require_admin_approval);
exception when duplicate_object then null; end $$;

-- ta_cfg() returns the ta_settings row type; re-create it now that the table
-- has two more columns, so the composite it hands back is definitely current.
create or replace function public.ta_cfg()
returns public.ta_settings language sql stable security definer set search_path = public as $$
  select * from public.ta_settings where id = true;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. LEAVE REQUESTS — dual-approval columns
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.ta_leave_requests
  add column if not exists manager_decision text,
  add column if not exists manager_by       uuid references public.ta_profiles(id),
  add column if not exists manager_at       timestamptz,
  add column if not exists manager_note     text,
  add column if not exists admin_decision   text,
  add column if not exists admin_by         uuid references public.ta_profiles(id),
  add column if not exists admin_at         timestamptz,
  add column if not exists admin_note       text,
  -- Snapshot of the rules at submission time, so changing the settings later
  -- can never strand a request that is already in flight.
  add column if not exists requires_manager boolean not null default true,
  add column if not exists requires_admin   boolean not null default true,
  add column if not exists attachment_path  text,
  add column if not exists attachment_name  text,
  add column if not exists balance_before   integer,
  add column if not exists balance_after    integer;

do $$ begin
  alter table public.ta_leave_requests
    add constraint ta_lr_mgr_decision check (manager_decision in ('approved','denied'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.ta_leave_requests
    add constraint ta_lr_adm_decision check (admin_decision in ('approved','denied'));
exception when duplicate_object then null; end $$;

-- Days already asked for but not yet decided. They do NOT touch the balance
-- (the brief is explicit), but they must count against what can still be
-- requested — otherwise 12 days of casual leave could be requested twice over.
create or replace function public.ta_leave_pending_days(p_emp uuid, p_type ta_leave_type)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(days), 0)::int from public.ta_leave_requests
   where employee_id = p_emp and leave_type = p_type and status = 'pending';
$$;

-- What the employee can still request for a type right now.
create or replace function public.ta_leave_available(p_emp uuid, p_type ta_leave_type)
returns integer language sql stable security definer set search_path = public as $$
  select greatest(0,
    coalesce((select remaining_days from public.ta_leave_balances
               where employee_id = p_emp and leave_type = p_type), 0)
    - public.ta_leave_pending_days(p_emp, p_type));
$$;

-- The workflow stage shown in the UI, derived from the two decision slots.
--   pending | waiting_admin | waiting_manager | approved | denied
create or replace function public.ta_leave_stage(r public.ta_leave_requests)
returns text language sql immutable as $$
  select case
    when r.status = 'approved' then 'approved'
    when r.status = 'denied'   then 'denied'
    when r.manager_decision = 'denied' or r.admin_decision = 'denied' then 'denied'
    when r.requires_admin   and r.admin_decision   is null
     and r.requires_manager and r.manager_decision is null then 'pending'
    when r.requires_admin   and r.admin_decision   is null then 'waiting_admin'
    when r.requires_manager and r.manager_decision is null then 'waiting_manager'
    else 'approved'
  end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. SUBMIT A LEAVE REQUEST
--    Validates everything server-side and creates a PENDING row.
--    It does NOT touch ta_leave_balances — that only happens on final approval.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ta_request_leave(
  p_leave_type      ta_leave_type,
  p_start           date,
  p_end             date,
  p_reason          text default null,
  p_attachment_path text default null,
  p_attachment_name text default null)
returns public.ta_leave_requests
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  cfg   public.ta_settings;
  n     integer;
  avail integer;
  pend  integer;
  clash date;
  req   public.ta_leave_requests;
begin
  if uid is null then raise exception 'Not signed in' using errcode = 'P0001'; end if;
  cfg := public.ta_cfg();

  if p_leave_type is null then
    raise exception 'Choose a leave type.' using errcode = 'P0001';
  end if;
  if p_start is null or p_end is null then
    raise exception 'Choose both a start and an end date.' using errcode = 'P0001';
  end if;
  if p_end < p_start then
    raise exception 'The end date cannot be before the start date.' using errcode = 'P0001';
  end if;
  if p_start < current_date then
    raise exception 'Leave cannot start in the past.' using errcode = 'P0001';
  end if;

  n := (p_end - p_start) + 1;                       -- inclusive day count
  if n < 1 then
    raise exception 'The date range must cover at least one day.' using errcode = 'P0001';
  end if;
  if n > 365 then
    raise exception 'A single leave request cannot exceed 365 days.' using errcode = 'P0001';
  end if;

  -- Serialise per employee so two parallel submissions can't both fit into the
  -- same remaining balance.
  perform 1 from public.ta_profiles where id = uid for update;

  -- ── BALANCE (the rule the client must not be able to bypass) ──────────────
  if not exists (select 1 from public.ta_leave_balances
                  where employee_id = uid and leave_type = p_leave_type) then
    raise exception 'You have no % leave allowance. Ask your admin to set one up.', p_leave_type
      using errcode = 'P0001';
  end if;

  avail := public.ta_leave_available(uid, p_leave_type);
  pend  := public.ta_leave_pending_days(uid, p_leave_type);
  if n > avail then
    raise exception 'Not enough % leave. You requested % day(s) but only % remain%s.',
      p_leave_type, n, avail,
      case when pend > 0
           then format(' (%s day(s) are already awaiting approval)', pend)
           else '' end
      using errcode = 'P0001';
  end if;

  -- ── CONFLICTS ─────────────────────────────────────────────────────────────
  if exists (select 1 from public.ta_leave_requests l
              where l.employee_id = uid and l.status in ('pending','approved')
                and l.start_date <= p_end and l.end_date >= p_start) then
    raise exception 'You already have a leave request covering some of those dates.'
      using errcode = 'P0001';
  end if;

  select g.d::date into clash
    from generate_series(p_start, p_end, interval '1 day') as g(d)
   where exists (select 1 from public.ta_rest_day_requests r
                  where r.employee_id = uid and r.status in ('pending','approved')
                    and g.d::date = any (r.dates))
   limit 1;
  if clash is not null then
    raise exception 'You already have a rest-day request covering %.',
      to_char(clash, 'Mon DD, YYYY') using errcode = 'P0001';
  end if;

  -- ── CREATE (pending — no balance movement) ────────────────────────────────
  insert into public.ta_leave_requests (
    employee_id, leave_type, start_date, end_date, days, reason, status,
    requires_manager, requires_admin, attachment_path, attachment_name, balance_before)
  values (
    uid, p_leave_type, p_start, p_end, n, nullif(btrim(coalesce(p_reason, '')), ''), 'pending',
    cfg.require_manager_approval, cfg.require_admin_approval,
    nullif(btrim(coalesce(p_attachment_path, '')), ''),
    nullif(btrim(coalesce(p_attachment_name, '')), ''),
    avail)
  returning * into req;

  -- Tell the requester …
  insert into public.ta_notifications (employee_id, title, message, type)
  values (uid, 'Leave Request Submitted',
          format('Your %s leave (%s → %s, %s day(s)) is pending approval. Your balance is unchanged until it is fully approved.',
                 p_leave_type, to_char(p_start, 'Mon DD'), to_char(p_end, 'Mon DD'), n),
          'leave_submitted');

  -- … and every approver who needs to see it.
  insert into public.ta_notifications (employee_id, title, message, type)
  select p.id, 'New Leave Request',
         format('%s requested %s day(s) of %s leave (%s → %s).',
                coalesce((select full_name from public.ta_profiles where id = uid), 'An employee'),
                n, p_leave_type, to_char(p_start, 'Mon DD'), to_char(p_end, 'Mon DD')),
         'leave_submitted'
    from public.ta_profiles p
   where p.id <> uid
     and ((cfg.require_admin_approval and p.role = 'admin')
       or (cfg.require_manager_approval and p.is_manager));

  return req;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. REVIEW A LEAVE REQUEST  (manager OR admin; either may go first)
--    Replaces the v1 two-argument ta_review_leave. The old call signature still
--    resolves because p_note carries a default.
-- ─────────────────────────────────────────────────────────────────────────────
drop function if exists public.ta_review_leave(uuid, text);

create or replace function public.ta_review_leave(
  p_request_id uuid, p_decision text, p_note text default null)
returns public.ta_leave_requests
language plpgsql security definer set search_path = public as $$
declare
  uid       uuid := auth.uid();
  r         public.ta_leave_requests;
  bal       public.ta_leave_balances;
  as_admin  boolean;
  as_mgr    boolean;
  slot      text;
  finalised boolean;
  stage     text;
begin
  if uid is null then raise exception 'Not signed in' using errcode = 'P0001'; end if;
  if p_decision not in ('approved','denied') then
    raise exception 'decision must be approved or denied' using errcode = 'P0001';
  end if;

  as_admin := public.ta_is_admin();
  as_mgr   := public.ta_is_manager();
  if not (as_admin or as_mgr) then
    raise exception 'Only a manager or an admin can review leave requests' using errcode = 'P0001';
  end if;

  select * into r from public.ta_leave_requests where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode = 'P0001'; end if;
  if r.status <> 'pending' then
    raise exception 'This request has already been %.', r.status using errcode = 'P0001';
  end if;
  if r.employee_id = uid then
    raise exception 'You cannot review your own leave request.' using errcode = 'P0001';
  end if;

  -- Which slot does this person fill? Somebody who is BOTH an admin and a
  -- manager fills one slot per call — the admin slot first — so a single
  -- person still cannot close a two-approver request in one click.
  if as_admin and r.requires_admin and r.admin_decision is null then
    slot := 'admin';
  elsif as_mgr and r.requires_manager and r.manager_decision is null then
    slot := 'manager';
  else
    raise exception 'You have already recorded your decision on this request.'
      using errcode = 'P0001';
  end if;

  if slot = 'admin' then
    update public.ta_leave_requests
       set admin_decision = p_decision, admin_by = uid, admin_at = now(), admin_note = p_note
     where id = p_request_id returning * into r;
  else
    update public.ta_leave_requests
       set manager_decision = p_decision, manager_by = uid, manager_at = now(), manager_note = p_note
     where id = p_request_id returning * into r;
  end if;

  -- ── A single rejection ends it ────────────────────────────────────────────
  if p_decision = 'denied' then
    update public.ta_leave_requests
       set status = 'denied', reviewed_by = uid, reviewed_at = now()
     where id = p_request_id returning * into r;

    insert into public.ta_notifications (employee_id, title, message, type)
    values (r.employee_id, 'Leave Rejected',
            format('Your %s leave (%s → %s) was rejected by the %s.%s',
                   r.leave_type, r.start_date, r.end_date, slot,
                   case when p_note is null or p_note = '' then '' else ' Note: ' || p_note end),
            'leave_denied');
    return r;
  end if;

  -- ── Approved this slot — is every required slot now approved? ─────────────
  finalised := (not r.requires_admin   or r.admin_decision   = 'approved')
           and (not r.requires_manager or r.manager_decision = 'approved');

  if not finalised then
    stage := public.ta_leave_stage(r);
    insert into public.ta_notifications (employee_id, title, message, type)
    values (r.employee_id, 'Leave Approval Progress',
            format('The %s approved your %s leave (%s → %s). It is now %s.',
                   slot, r.leave_type, r.start_date, r.end_date,
                   case stage when 'waiting_admin'   then 'waiting for admin approval'
                              when 'waiting_manager' then 'waiting for manager approval'
                              else 'awaiting further approval' end),
            'leave_submitted');
    return r;
  end if;

  -- ── FINAL APPROVAL — the one and only place the balance moves ─────────────
  select * into bal from public.ta_leave_balances
   where employee_id = r.employee_id and leave_type = r.leave_type for update;
  if not found then
    raise exception 'That employee has no % leave balance to deduct from.', r.leave_type
      using errcode = 'P0001';
  end if;
  -- Re-check at approval time: the balance may have moved since submission.
  if r.days > bal.remaining_days then
    raise exception 'Cannot approve: % has % day(s) of % leave left but this request is for %.',
      coalesce((select full_name from public.ta_profiles where id = r.employee_id), 'the employee'),
      bal.remaining_days, r.leave_type, r.days using errcode = 'P0001';
  end if;

  update public.ta_leave_balances
     set used_days = used_days + r.days
   where employee_id = r.employee_id and leave_type = r.leave_type
   returning * into bal;

  update public.ta_leave_requests
     set status = 'approved', reviewed_by = uid, reviewed_at = now(),
         balance_after = bal.remaining_days
   where id = p_request_id returning * into r;

  insert into public.ta_notifications (employee_id, title, message, type)
  values (r.employee_id, 'Leave Approved',
          format('Your %s leave (%s → %s, %s day(s)) is fully approved. You have %s %s day(s) left.',
                 r.leave_type, r.start_date, r.end_date, r.days, bal.remaining_days, r.leave_type),
          'leave_approved');

  return r;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. ADMIN CONFIG RPCs
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.ta_set_manager(p_employee uuid, p_is_manager boolean)
returns public.ta_profiles language plpgsql security definer set search_path = public as $$
declare p public.ta_profiles;
begin
  if not public.ta_is_admin() then
    raise exception 'Only an admin can grant or remove manager rights' using errcode = 'P0001';
  end if;
  update public.ta_profiles set is_manager = coalesce(p_is_manager, false)
   where id = p_employee returning * into p;
  if not found then raise exception 'employee not found' using errcode = 'P0001'; end if;
  return p;
end $$;

create or replace function public.ta_set_approval_flow(
  p_require_manager boolean, p_require_admin boolean)
returns public.ta_settings language plpgsql security definer set search_path = public as $$
declare s public.ta_settings;
begin
  if not public.ta_is_admin() then
    raise exception 'Only an admin can change the approval flow' using errcode = 'P0001';
  end if;
  if not (coalesce(p_require_manager, false) or coalesce(p_require_admin, false)) then
    raise exception 'At least one approver must be required.' using errcode = 'P0001';
  end if;
  update public.ta_settings
     set require_manager_approval = coalesce(p_require_manager, require_manager_approval),
         require_admin_approval   = coalesce(p_require_admin,   require_admin_approval),
         updated_by = auth.uid(), updated_at = now()
   where id = true returning * into s;
  return s;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ATTACHMENTS — private Storage bucket
--    Guarded: if the storage schema isn't reachable the rest of the migration
--    still succeeds and the app simply hides the attachment field.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('ta-leave-files', 'ta-leave-files', false, 5242880,
          array['image/png','image/jpeg','image/webp','image/heic','application/pdf'])
  on conflict (id) do update
    set public = false,
        file_size_limit = 5242880,
        allowed_mime_types = array['image/png','image/jpeg','image/webp','image/heic','application/pdf'];

  -- Files live under  <employee_uuid>/<filename>  so ownership is path-derived.
  execute $p$ drop policy if exists ta_leavefile_ins on storage.objects $p$;
  execute $p$ create policy ta_leavefile_ins on storage.objects for insert to authenticated
              with check (bucket_id = 'ta-leave-files'
                          and (storage.foldername(name))[1] = auth.uid()::text) $p$;

  execute $p$ drop policy if exists ta_leavefile_sel on storage.objects $p$;
  execute $p$ create policy ta_leavefile_sel on storage.objects for select to authenticated
              using (bucket_id = 'ta-leave-files'
                     and ((storage.foldername(name))[1] = auth.uid()::text
                          or public.ta_is_approver())) $p$;

  execute $p$ drop policy if exists ta_leavefile_del on storage.objects $p$;
  execute $p$ create policy ta_leavefile_del on storage.objects for delete to authenticated
              using (bucket_id = 'ta-leave-files'
                     and ((storage.foldername(name))[1] = auth.uid()::text
                          or public.ta_is_admin())) $p$;
exception when others then
  raise notice 'Storage bucket setup skipped (%). Leave attachments will be disabled; everything else works.', sqlerrm;
end $$;

-- ============================================================================
--  8. ROW LEVEL SECURITY
-- ============================================================================

-- ── profiles: approvers must be able to read the people they review ─────────
drop policy if exists ta_prof_sel on public.ta_profiles;
create policy ta_prof_sel on public.ta_profiles for select to authenticated
  using (id = auth.uid() or public.ta_is_admin() or public.ta_is_manager());

-- ── leave balances: approvers need to see the balance beside the request ────
drop policy if exists ta_bal_sel on public.ta_leave_balances;
create policy ta_bal_sel on public.ta_leave_balances for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin() or public.ta_is_manager());

-- ── leave requests ──────────────────────────────────────────────────────────
drop policy if exists ta_req_sel on public.ta_leave_requests;
create policy ta_req_sel on public.ta_leave_requests for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin() or public.ta_is_manager());

--  No direct INSERT: ta_request_leave() is the only way in, so the balance and
--  overlap checks always run.
drop policy if exists ta_req_ins on public.ta_leave_requests;

--  No direct UPDATE for anyone — not even an admin. Without this, an admin
--  could PATCH status straight to 'approved' and the balance would never be
--  deducted, breaking the "only after final approval" rule. ta_review_leave()
--  is SECURITY DEFINER and bypasses this, so the UI is unaffected.
drop policy if exists ta_req_upd on public.ta_leave_requests;

-- ── attendance / notifications: let managers see their team ─────────────────
drop policy if exists ta_att_sel on public.ta_attendance;
create policy ta_att_sel on public.ta_attendance for select to authenticated
  using (employee_id = auth.uid() or public.ta_is_admin() or public.ta_is_manager());

-- ============================================================================
--  9. GRANTS
-- ============================================================================
--  Employees keep SELECT (RLS narrows it to their own rows) but lose the
--  INSERT/UPDATE they used to hold on ta_leave_requests.
revoke insert, update, delete on public.ta_leave_requests from authenticated;
grant  select on public.ta_leave_requests to authenticated;

grant execute on function public.ta_is_manager()                       to authenticated;
grant execute on function public.ta_is_approver()                      to authenticated;
grant execute on function public.ta_manager_count()                    to authenticated;
grant execute on function public.ta_leave_pending_days(uuid, ta_leave_type) to authenticated;
grant execute on function public.ta_leave_available(uuid, ta_leave_type)    to authenticated;
grant execute on function public.ta_leave_stage(public.ta_leave_requests)   to authenticated;
grant execute on function public.ta_request_leave(ta_leave_type, date, date, text, text, text) to authenticated;
grant execute on function public.ta_review_leave(uuid, text, text)     to authenticated;
grant execute on function public.ta_set_manager(uuid, boolean)         to authenticated;
grant execute on function public.ta_set_approval_flow(boolean, boolean) to authenticated;

-- ============================================================================
--  DONE. Sanity checks:
--
--   -- Who can approve?
--   select full_name, role, is_manager from public.ta_profiles order by role desc, full_name;
--
--   -- Promote someone to manager (or use Admin → Employees in the app):
--   -- update public.ta_profiles set is_manager = true where lower(email) = 'manager@ringroad.re';
--
--   -- Approval flow currently in force:
--   select require_manager_approval, require_admin_approval from public.ta_settings;
--
--   -- Requests with their derived stage:
--   select l.id, p.full_name, l.leave_type, l.start_date, l.end_date, l.days,
--          l.status, public.ta_leave_stage(l.*) as stage,
--          l.manager_decision, l.admin_decision
--     from public.ta_leave_requests l
--     join public.ta_profiles p on p.id = l.employee_id
--    order by l.created_at desc;
--
--  NOTE: if require_manager_approval is true you must designate at least one
--  manager, otherwise requests stay pending forever. The admin Leave Requests
--  screen shows a warning when that is the case.
-- ============================================================================
