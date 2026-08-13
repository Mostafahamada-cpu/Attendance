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
  public.ta_leave_balances,
  public.ta_leave_requests,
  public.ta_weekly_off_days,
  public.ta_notifications
to authenticated;

-- The leave-review RPC is called from the admin UI by authenticated users.
grant execute on function public.ta_review_leave(uuid, text) to authenticated;

-- ── Verify (should all return TRUE) ─────────────────────────────────────────
select
  has_table_privilege('authenticated','public.ta_profiles','SELECT')       as profiles_select,
  has_table_privilege('authenticated','public.ta_attendance','SELECT')     as attendance_select,
  has_table_privilege('authenticated','public.ta_attendance','INSERT')     as attendance_insert,
  has_table_privilege('authenticated','public.ta_leave_requests','SELECT') as leave_requests_select,
  has_table_privilege('authenticated','public.ta_leave_requests','INSERT') as leave_requests_insert;
