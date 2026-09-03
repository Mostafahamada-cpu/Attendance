-- ============================================================================
--  RingRoad Attendance — FIX: table GRANTs for the `authenticated` role
--  ---------------------------------------------------------------------------
--  Run in the Supabase SQL Editor on the shared RingRoad project.
--
--  WHY: the ta_* tables have RLS enabled with correct policies, but the
--  `authenticated` role was never granted table privileges. Postgres therefore
--  raises 42501 "permission denied for table" BEFORE RLS is evaluated, and
--  PostgREST returns HTTP 401 to logged-in users.
--
--  This does NOT disable RLS (RLS stays ON and remains the real row-level gate)
--  and does NOT grant `anon` (these tables require an authenticated session).
--  It only lets the authenticated role reach the tables so RLS can do its job.
--  Idempotent — safe to re-run. Touches only ta_* objects; no RingRoad tables.
-- ============================================================================

grant usage on schema public to authenticated;   -- normally already present

grant select, insert, update, delete on
  public.ta_profiles,
  public.ta_attendance,
  public.ta_weekly_off_days,
  public.ta_notifications
to authenticated;

-- ── DELIBERATELY SELECT-ONLY ────────────────────────────────────────────────
--  ta_leave_requests (schema-v3) and ta_leave_balances (schema-v4) are written
--  ONLY through their SECURITY DEFINER RPCs. Granting write here would undo
--  that on the next re-run of this file and reopen two holes those migrations
--  closed: PATCHing a request straight to `approved` so the balance deduction
--  never runs, and PATCHing `used_days` out of step with the leave that
--  produced it. The RPCs run as the function owner, so they do not need these
--  grants. Leave them as SELECT.
grant select on
  public.ta_leave_balances,
  public.ta_leave_requests
to authenticated;
revoke insert, update, delete on
  public.ta_leave_balances,
  public.ta_leave_requests
from authenticated;

-- The leave-review RPC is called from the admin UI by authenticated users.
-- (schema-v3 replaces this two-argument version with ta_review_leave(uuid, text, text);
--  the guard keeps this file runnable either before or after that migration.)
do $$ begin
  grant execute on function public.ta_review_leave(uuid, text) to authenticated;
exception when undefined_function then
  raise notice 'ta_review_leave(uuid,text) not present — schema-v3 grants the 3-arg version.';
end $$;

-- ── Verify (should all return TRUE) ─────────────────────────────────────────
select
  has_table_privilege('authenticated','public.ta_profiles','SELECT')       as profiles_select,
  has_table_privilege('authenticated','public.ta_attendance','SELECT')     as attendance_select,
  has_table_privilege('authenticated','public.ta_attendance','INSERT')     as attendance_insert,
  has_table_privilege('authenticated','public.ta_leave_requests','SELECT') as leave_requests_select,
  -- These two must be FALSE: writes go through the RPCs, never the table.
  has_table_privilege('authenticated','public.ta_leave_requests','INSERT')  as req_insert_expect_false,
  has_table_privilege('authenticated','public.ta_leave_balances','UPDATE')  as bal_update_expect_false;

-- ── v2 tables (db/schema-v2.sql) ────────────────────────────────────────────
--  These are intentionally SELECT-only for the `authenticated` role: every
--  write goes through a SECURITY DEFINER RPC so the business rules (2 weekend
--  changes, rest-day availability, the geofence) can't be skipped by calling
--  PostgREST directly. Run db/schema-v2.sql first — it creates these objects
--  and issues the same grants; this block is only here for re-verification.
do $$ begin
  grant select on
    public.ta_settings, public.ta_weekend_change_requests,
    public.ta_rest_balances, public.ta_rest_day_requests, public.ta_geo_attempts
  to authenticated;
  grant update on public.ta_settings to authenticated;   -- gated by RLS: admins only
exception when undefined_table then
  raise notice 'v2 tables not found — run db/schema-v2.sql first.';
end $$;

-- ── v7 tables (db/schema-v7.sql) ────────────────────────────────────────────
--  Salary, payroll and leave permissions. SELECT-only for `authenticated`, and
--  that includes admins: every write goes through an admin-gated SECURITY
--  DEFINER RPC. Granting write here would undo what the migration closed —
--  PATCHing your own salary or grace period, or INSERTing a leave permission
--  straight in as `approved` so the 3-per-month rule never runs. The REVOKE is
--  what makes this file safe to re-run after somebody has "helpfully" added a
--  grant by hand.
do $$ begin
  grant select on
    public.ta_shifts, public.ta_holidays, public.ta_salary_rules,
    public.ta_payroll_adjustments, public.ta_leave_permissions
  to authenticated;
  revoke insert, update, delete on
    public.ta_shifts, public.ta_holidays, public.ta_salary_rules,
    public.ta_payroll_adjustments, public.ta_leave_permissions
  from authenticated;
exception when undefined_table then
  raise notice 'v7 tables not found — run db/schema-v7.sql first.';
end $$;

-- Expect all FALSE:
select
  has_table_privilege('authenticated','public.ta_salary_rules','UPDATE')       as salary_update,
  has_table_privilege('authenticated','public.ta_salary_rules','INSERT')       as salary_insert,
  has_table_privilege('authenticated','public.ta_leave_permissions','INSERT')  as perm_insert,
  has_table_privilege('authenticated','public.ta_leave_permissions','UPDATE')  as perm_update,
  has_table_privilege('authenticated','public.ta_payroll_adjustments','INSERT') as payadj_insert;
