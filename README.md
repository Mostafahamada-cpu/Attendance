# RingRoad · Attendance & Time-Off

A modern, mobile-first **Attendance & Time-Off** app for employees and management.
Standalone and fully **isolated** from the existing RingRoads platform — its own folder,
its own styles, its own routing, and its own `ta_*` database tables.

- **Frontend:** vanilla ES modules, no build step (same proven stack as `MD/platform`).
- **Backend:** Supabase — Auth + PostgreSQL + Row Level Security + Realtime-ready.
- **Brand:** teal-green `#24AAA5`, soft pastel blobs, rounded cards, gradient clock buttons.

---

## 1. What's inside

```
attendance-app/
├── index.html              # app shell
├── config.js               # ← your Supabase URL + anon key (git-ignored)
├── config.example.js       # template to copy
├── css/                    # tokens · base · components (design system)
├── db/
│   ├── schema.sql          # tables, RLS, triggers, atomic leave-review RPC
│   ├── schema-v2.sql       # ← geofence · weekend changes · rest days (run after schema.sql)
│   ├── schema-v3.sql       # ← manager role · two-stage leave approval (run after v2)
│   ├── schema-v4.sql       # ← admin vacation-balance management (run after v3)
│   ├── schema-v7.sql       # ← shifts · salary rules · payroll · leave permissions
│   ├── provision-users-v2.sql  # ← the seven new/updated users (run after v4)
│   ├── fix-ayman-admin.sql     # ← makes Ayman Madbouly an active admin
│   ├── fix-admin-roles.sql     # ← EXACTLY two admins (run last, authoritative)
│   └── seed.sql            # role promotion + demo off-days (edit emails)
└── js/
    ├── app.js              # session, routing, employee + admin shells
    ├── lib/                # supabase · data · ui · time · toast · geo · storage ·
    │                       #   verify (clock-out word) · money (payroll formatting)
    └── pages/
        ├── login.js
        ├── shared/         # leave-review · security (Change Password, both shells)
        ├── employee/       # home · apply-leave · my-leaves · calendar · notifications ·
        │                   #   chat · more · weekend · rest-days · approvals (managers) ·
        │                   #   permissions (leave permissions) · salary (own payroll)
        └── admin/          # dashboard · leaves · employees · balances · offdays ·
                            #   weekend · rest-days · geofence · analytics · account ·
                            #   salary-rules · payroll · permissions
```

## 2. Setup (≈ 5 minutes)

### a. Configure Supabase credentials
`config.js` already exists and defaults to the existing RingRoads project. To use a
**fresh, fully-isolated** project instead, copy the template and edit two values:

```bash
cp config.example.js config.js   # then set SUPABASE_URL + SUPABASE_ANON_KEY
```

Find them in **Supabase Dashboard → Project Settings → API**. The anon/publishable
key is safe in the browser (protected by RLS); `config.js` is git-ignored regardless.

### b. Create the database
Open **Supabase Dashboard → SQL Editor → New query**, paste the whole of
[`db/schema.sql`](db/schema.sql) and **Run**. It is idempotent and namespaced `ta_*`,
so it never touches existing platform tables. This creates:

`ta_profiles` · `ta_attendance` · `ta_leave_balances` · `ta_leave_requests` ·
`ta_weekly_off_days` · `ta_notifications` — all with RLS, plus:

- a trigger that **auto-creates a profile + default leave balances** for every new user
  (12 casual / 8 medical / 5 planned = 25 total; edit in `ta_handle_new_user()`);
- `ta_review_leave(request_id, decision)` — a `SECURITY DEFINER` RPC that approves/denies
  **atomically**: flips status, deducts balance on approval, and notifies the employee.

### b2. Run the v2 migration (REQUIRED)
Then paste and run [`db/schema-v2.sql`](db/schema-v2.sql). It is additive and idempotent —
it never drops a table or a row — and it is what makes clock in/out, weekend changes and
rest days work. It adds:

`ta_settings` (geofence centre, radius, rest allotment) · `ta_weekend_change_requests` ·
`ta_rest_balances` · `ta_rest_day_requests` · `ta_geo_attempts`, geofence columns on
`ta_attendance`, and the SECURITY DEFINER RPCs that are now the **only** write path for
these features:

| RPC | Enforces |
| --- | --- |
| `ta_clock_in` / `ta_clock_out` | Recomputes the distance server-side and refuses anything outside the radius; logs every attempt |
| `ta_request_weekend_change` | Max 2 changes; #1 auto-approved, #2 pending |
| `ta_review_weekend_change` | Admin-only; applies the new off-days on approval |
| `ta_request_rest_days` | Availability + overlap checks |
| `ta_review_rest_days` | Admin-only; deducts the balance atomically |
| `ta_set_geofence` | Admin-only; radius clamped to 100–200 m |
| `ta_set_rest_balance` | Admin-only; total can't drop below days already used |

The migration also **revokes** employees' direct `INSERT`/`UPDATE` on `ta_attendance`, so
the geofence cannot be skipped by hand-crafting a PostgREST call.

> Verify it landed:
> ```sql
> select geofence_lat, geofence_lng, geofence_radius_m, rest_days_default from public.ta_settings;
> ```

### b3. Run the v3 migration (REQUIRED)
Finally, paste and run [`db/schema-v3.sql`](db/schema-v3.sql). Additive and idempotent
like the others. It turns leave into a real two-stage HR workflow and adds:

- **`ta_profiles.is_manager`** — the manager capability. A manager is an ordinary employee
  (they still clock in and take leave) who can also approve leave. Deliberately a boolean
  rather than a new `ta_role` enum value: an enum value can't be *used* in the same
  transaction that adds it, which would make a one-script migration fragile. Every existing
  `role = 'employee' / 'admin'` check is untouched.
- **Dual-approval columns** on `ta_leave_requests` — an independent decision slot for the
  manager and for the admin, plus `attachment_path`, `balance_before` and `balance_after`.
- **`ta_request_leave(...)`** and a rewritten **`ta_review_leave(id, decision, note)`**.
- **A private Storage bucket** `ta-leave-files` for medical certificates, with policies
  letting an employee read only their own folder and approvers read all. If your project
  can't create the bucket the migration still succeeds — it prints a notice and the app
  simply hides the attachment field.
- **A privilege-escalation fix.** The existing `ta_profiles` UPDATE policy allows
  `id = auth.uid()`, which also let a user set their own `role = 'admin'`. A trigger now
  blocks any non-admin from changing `role` or `is_manager`. Direct database sessions (the
  SQL editor, `service_role`) are exempt, so `seed.sql` keeps working.

> After running it, give at least one person manager rights — **Admin → Employees → pick a
> person → Manager rights** — or leave requests will sit at *Waiting for Manager* forever.
> The admin Leave Requests screen shows a warning until you do.

### b4. Run the v4 migration (REQUIRED)
Paste and run [`db/schema-v4.sql`](db/schema-v4.sql). Additive and idempotent. It is what
makes **Admin → Vacation Balances** editable:

- **`ta_balance_adjustments`** — an append-only audit trail: who changed whose allowance,
  from what to what, when, and why.
- **`ta_set_leave_balance(employee, type, total, note)`** and
  **`ta_set_leave_balances(employee, casual, medical, planned, note)`** — SECURITY DEFINER,
  admin-gated. The plural one applies all three types in a single transaction, so a rejected
  figure rolls the others back instead of leaving a half-applied edit.
- **`ta_leave_balances` becomes read-only over the API for everyone, admins included.**
  `ta_bal_upd` / `ta_bal_ins` are dropped and the grants revoked, so the RPC is the only way
  a total can move. That is what stops an admin PATCHing `used_days` out of step with the
  approved leave that produced it — and what stops an employee touching their own balance.
- A backfill giving every existing profile all three balance rows.

> Verify it landed:
> ```sql
> select has_table_privilege('authenticated','public.ta_leave_balances','UPDATE') as should_be_false;
> ```

### b5. Provision the seven new/updated users (optional)
[`db/provision-users-v2.sql`](db/provision-users-v2.sql) adds Sherif, Omar Ayman, Peter and
Mostafa, sets **Mr Sayed** back to *employee · TeleSales · Team Leader*, and creates/confirms
the two Ayman **admin** accounts. It is
idempotent and creates **no duplicates**: accounts are matched by email and existing ones are
updated in place with their **passwords untouched**. It never auto-creates an admin — the
admin rows are promote-only, so a typo cannot mint an administrator. Its final two `SELECT`s
report each person's access tier and flag any roster entry that matched no account.

### b6. Make Ayman Madbouly an admin (REQUIRED)
[`db/fix-ayman-admin.sql`](db/fix-ayman-admin.sql) guarantees
`ayman.madbouly@ringroad.re` **exists, can log in, and is an admin**. It is small and
self-contained, so it can be run on its own — `provision-users-v2.sql` already covers him,
and this is the belt-and-braces version you can point at the problem directly.

It creates the account only if it is genuinely missing (existing password untouched),
confirms the email, clears `banned_until` / `deleted_at`, adds the `email` identity row that
password sign-in needs, sets `ta_profiles.role = 'admin'`, and seeds his balances. It ends
with a verification query whose columns must all read true:

```sql
select p.role, (u.email_confirmed_at is not null) as confirmed,
       exists (select 1 from auth.identities i where i.user_id = u.id and i.provider='email') as can_login
  from public.ta_profiles p join auth.users u on u.id = p.id
 where lower(p.email) = 'ayman.madbouly@ringroad.re';
```

`role = 'admin'` is the whole story for permissions: `ta_is_admin()` reads that column, and
every admin RLS policy and admin RPC — `ta_set_leave_balance` included — calls `ta_is_admin()`.
The frontend route guard reads the same field. There is nothing else to flip.

> It deliberately does **not** reset an existing password. If he still cannot sign in after
> this, reset it in **Authentication → Users** or use *Forgot password?* on the login screen.

### b7. Enforce exactly two admins (REQUIRED — run this last)
[`db/fix-admin-roles.sql`](db/fix-admin-roles.sql) is the **authoritative** script for who
administers the system. There are **exactly two administrators and no others**:

| | |
| --- | --- |
| Ayman Madbouly | `ayman.madbouly@ringroad.re` |
| Mohamed Ayman | `mohamed.ayman@ringroad.re` |

It syncs `ta_profiles.email` from `auth.users`, makes sure both accounts exist and can log in,
grants them `admin` — and then **demotes every other admin to `employee`**. Mr Sayed in
particular is restored to the record his original provisioning data gives him
(*employee · TeleSales · Team Leader*, per `provision-users.sql` and `fix-shared-profiles.sql`).
No account is created for him and none is deleted; only the `role` column moves.

Changing who administers the system means editing the two-row allow-list at the top of that
file and re-running it. It is idempotent — a second run reports no changes.

It ends with six verification blocks, including the exact query from the requirement:

```sql
select full_name, email, role from public.ta_profiles where role = 'admin';
-- must return ONLY Ayman Madbouly and Mohamed Ayman
```

plus a PASS/FAIL count, per-admin boolean assertions, a Mr-Sayed-specific check, the final
roles of everyone provisioned, and a `raise warning` you cannot miss in the output pane if the
count is ever anything but two. (A *warning*, not an exception — raising would roll back the
fix the script had just applied.)

### b8. Run the v7 migration (REQUIRED)
Paste and run [`db/schema-v7.sql`](db/schema-v7.sql). Additive and idempotent. It is what
makes **Salary & Rules**, **Payroll** and **Leave Permissions** work:

- **`ta_shifts`** — the three company shifts, seeded on a stable `code` so re-running never
  makes a fourth copy and never overwrites hours an admin has edited:
  *Shift 1* 09:00→17:00 · *Shift 2* 10:00→18:00 · *Shift 3* 11:00→19:00.
- **`ta_salary_rules`** — one row **per existing employee**, not a second employee table:
  monthly salary, shift, optional per-person hours, grace period, late rate + optional daily
  cap, absence basis/multiplier, permission allowance and permission-deduction settings,
  active flag. Weekly days off stay in the existing **`ta_weekly_off_days`** — the schedule is
  never duplicated.
- **`ta_holidays`** — a company holiday is not a working day, so it is never an absence.
- **`ta_payroll_adjustments`** — manual "other deductions", unique on
  `(employee, month, lower(label))`, so re-entering the same charge **edits** it instead of
  adding a second one.
- **`ta_leave_permissions`** — permission to step out during a working day. Three per calendar
  month (configurable) are approved on submission; #4 and beyond are created `pending`.
- **`ta_payroll(employee, year, month)`** / **`ta_payroll_all(year, month)`** — the whole
  monthly calculation, derived on every call.
- **`ta_set_salary_rules(...)`, `ta_set_shift(...)`, `ta_set_payroll_defaults(...)`,
  `ta_set_payroll_adjustment(...)`, `ta_set_holiday(...)`, `ta_review_permission(...)`** —
  SECURITY DEFINER, admin-gated.
- **`ta_request_permission(...)`** — the employee's only way in. It counts their own approved
  permissions for that month **in the database** and decides the status itself, so nobody can
  submit one pre-approved.
- `ta_settings` gains **`timezone`** (default `Africa/Cairo`) plus the company defaults a new
  employee inherits. Every lateness comparison converts the stored `timestamptz` into that
  zone, so the answer never depends on a browser's clock.
- A backfill giving every existing profile a rules row, and — only if they have **none** —
  the default weekly days off for their role (**Sales → Friday**, everyone else →
  **Friday + Saturday**). An existing schedule is never overwritten.

> **All four new tables are read-only over the API for everyone, admins included.** No
> INSERT/UPDATE/DELETE policy is created and the grants are revoked, so the RPCs are the only
> route. In particular an employee cannot INSERT a permission row with `status = 'approved'`,
> because they cannot INSERT one at all.
>
> Verify it landed:
> ```sql
> select has_table_privilege('authenticated','public.ta_salary_rules','UPDATE')      as rules_upd,
>        has_table_privilege('authenticated','public.ta_leave_permissions','INSERT')  as perm_ins;
> -- both must be FALSE
> select code, name, start_time, end_time from public.ta_shifts order by sort_order;
> ```
>
> If a new screen reports *"Could not find the function/table"*, PostgREST hasn't picked up the
> new schema yet. Run `notify pgrst, 'reload schema';` in the SQL editor.

### c. Create users

**Dashboard → Authentication → Users → Add user** (tick **Auto Confirm User**). Create at
least one admin and two employees, e.g. `admin@ringroad.re`, `employee1@…`, `employee2@…`.
The trigger provisions each profile automatically.

### d. Assign roles / demo data
Edit the emails in [`db/seed.sql`](db/seed.sql) to match what you created, then run it in
the SQL editor. It promotes the admin, sets departments, and seeds Fri/Sat off-days.
(You can also just flip a role by hand:
`update public.ta_profiles set role='admin' where email='admin@ringroad.re';`)

### d2. (Optional) Bulk-provision the team
To create/align the full employee roster in one shot, run [`db/provision-users.sql`](db/provision-users.sql)
in the SQL Editor. It is idempotent and safe on the shared project: it creates only accounts that
don't already exist (existing passwords untouched), sets each person's role/department, seeds leave
balances, and prints a report of who is admin vs employee and which accounts were newly created.

### e. Run it
```bash
cd attendance-app
python -m http.server 5178        # or: npx serve .
```
Open `http://localhost:5178`. Employees land on **Home**, admins on the **Dashboard**.

## 3. Feature map

**Employee (mobile-first):** real Supabase login · gradient Clock-In/Out with live timer ·
duplicate-clock-in prevention · today's stats · leave-balance donut rings · apply-for-leave
with full validation · My Leaves with status pills · month calendar honouring each person's
off-days · functional notifications · Chat placeholder · More/profile/change-password/logout.

**Employee (v2):** live location strip with your distance from the office · geofenced
Clock In/Out with a per-failure explanation · **My Weekend** (allowance meter, day picker,
change history) · **Rest Days** (balance rings, period + exact-date picker, request history).

**Employee (v3):** Apply Leave with live day count, per-type availability and a
remaining-after-approval preview · optional attachment (medical certificates) · My Leaves
showing the two-step approval trail per request · calendar overlay for approved and
pending leave. **Managers** additionally get an **Approvals** tab.

**Admin (desktop-first, responsive):** KPI dashboard (present / working / not-in / pending /
team) · live "Who's In Right Now" (polls every 20s) · leave requests with **Approve/Deny →
balance auto-updates + notification** · employee drill-down (calendar stats, history, weekly
pattern) · team leave-balance table with search & smart filters · per-employee weekly off-day
editor · analytics (today/week/month/custom → total & avg hours, attendance rate, late
arrivals, absences, daily-hours chart).

**Everyone (v5):** a **Security → Change Password** section in the settings screen, with
current-password verification, per-field errors, and the session preserved afterwards.

**Employee (v7):** a **verification word on Clock Out** — a modal asks for `RingRoad`
(case-insensitive, trimmed) before the day is ended · **Leave Permissions** — request time out
during a working day, with a live `Used n / 3` counter, an instant-approval preview and the
month-by-month history · **My Salary & Schedule** — your own shift, grace period, days off,
deductions and estimated net salary, month by month. Nobody can see anyone else's.

**Admin (v7):** **Salary & Attendance Rules** — company defaults (timezone, salary, grace,
late rate, permission allowance), the three work shifts, the holiday calendar, and a
per-employee rules table with an **Edit rules** dialog (also reachable from each person's card
under **Employees**) · **Payroll** — pick a month, see base / working days / present / late
days / late minutes / late deduction / absence days / absence deduction / permissions / other
/ total deductions / net salary for everyone, then open a **Breakdown** that explains every
EGP with the date it came from · **Leave Permissions** — approve or reject the ones beyond an
employee's monthly allowance and read anyone's full history · the Dashboard gains an
**Approved Leave Permissions Today** list so authorised time out is never read as an absence.

**Admin (v4):** **Vacation Balances** — the team table now lists *everyone* (admins take
leave too) and every row has an **Edit balance** action; the same **Edit Vacation Balance**
dialog is on each person's card under **Employees**. Set Casual / Medical / Planned days,
add an optional reason, save. Also **My Account** — the admin shell had no bottom nav and
therefore no route to *Change Password*; administrators now have one.

**Admin (v3):** **Leave Requests** rebuilt around dual approval — *Awaiting you / In
progress / Approved / Rejected* buckets, full request detail with balance and attachment,
an approval trail, and an **Approval flow** card for which approvers are required ·
**Employees** gains a per-person **Manager rights** toggle.

**Admin (v2):** **Weekend Changes** (usage per employee, 1st vs 2nd slot, approve/reject the
second with a note) · **Rest Days** (review requests, per-employee balance table, set totals)
· **Geofence** (coordinates, 100–200 m radius slider, GPS-accuracy threshold, enforcement
toggle, today's clock in/out locations, and a filterable log of every passed and blocked
attempt with distance, accuracy and a maps link).

## 3b. Attendance rules (v2)

### Clock in / clock out geofence
The official attendance location is **29.979897570225, 31.357097369334436**, with a
**150 m** default radius that an admin can set anywhere between **100 m and 200 m**
(*Admin → Geofence*). Pressing Clock In or Clock Out reads the device GPS, measures the
real distance to that point, and only proceeds if you are inside the radius; the home
screen shows a live status strip with your distance before you tap.

The check is **not** frontend-only. `ta_clock_in` / `ta_clock_out` recompute the distance
in Postgres from `ta_settings` — any distance sent by the client is ignored — and refuse
readings with missing, impossible or implausibly coarse coordinates. Because employees no
longer hold `INSERT`/`UPDATE` on `ta_attendance`, calling PostgREST directly cannot create
an attendance row at all. Every attempt, allowed or blocked, is written to
`ta_geo_attempts` with lat, lng, accuracy, distance, radius, result and timestamp, and the
same values are stored on the attendance row itself.

> The RPCs deliberately **return** `{ ok: false, error, reason }` rather than raising when
> the geofence refuses — a `raise` would roll back the audit row along with the rejection,
> leaving the log full of successes only.

GPS problems are handled explicitly, each with its own message and recovery action:
permission denied (with per-browser instructions), location services off, timeout (retried
once with a coarse-fix fallback), unsupported browser, insecure (non-HTTPS) origin, and
readings too inaccurate to trust.

### Weekend changes — 2 per employee, ever
*Employee → More → My Weekend* shows how many changes are used and how many remain.

1. **First change** — approved automatically and applied the moment it's submitted.
2. **Second change** — submitted as a request; an admin approves or rejects it in
   *Admin → Weekend Changes*, and only approval updates the weekly off-days.
3. **Third** — refused.

The cap lives in the database: `change_number` is `CHECK`ed to 1–2 and a partial unique
index allows only one live request per slot, on top of the guard inside
`ta_request_weekend_change`. A request **rejected by an admin** does not consume an
allowance, so the employee can submit a different one; pending and approved ones do. A new
weekend must have the same number of days as the current one — you move it, not lengthen it.

### Rest days
*Employee → More → Rest Days*. Pick the **period** (from → to), then tick the **exact
dates** inside it. Availability is `total − used − days already reserved by pending
requests`; the picker caps selection at that number, greys out dates that clash with your
weekly off-days, an existing rest request or a leave request, and refuses past dates.

`ta_request_rest_days` re-checks all of it server-side and rejects an over-budget request
with a clear message, so trimming the payload in devtools changes nothing. Each request
stores the selected dates, the count, the balance before, and — once approved — the balance
after. Admins review requests and set each person's total in *Admin → Rest Days*;
approval deducts the balance atomically and re-verifies it at approval time.

## 3c. Leave workflow (v3)

### Applying
**Home → Apply Leave** (or *My Leaves → New Leave Request*). Pick the type — Casual,
Medical or Planned — then **From Date** and **To Date**. The number of requested days is
calculated live and inclusively, so 25 Aug → 28 Aug is **4 days**. A To Date before the
From Date, or a start date in the past, blocks submission with an inline message.

Beneath the dates the card shows the balance for the selected type, anything already
awaiting approval, what is **available to request**, and — once the request is valid —
**remaining after approval**. Reason is optional. An attachment is optional too, allowed
for any type and prompted for Medical ("Attach a medical certificate if your organisation
requires one"); files are PDFs or images up to 5 MB, stored privately.

`ta_request_leave()` re-runs every one of those checks server-side, so editing the request
in devtools changes nothing. Employees no longer hold `INSERT` on `ta_leave_requests` —
the RPC is the only way in.

### Availability vs. balance
Submitting **never** moves a balance. But pending days can't be double-spent either, so
what you may still request is `remaining − days already awaiting approval`. With 9 casual
days remaining and 7 pending, 2 are available; asking for 3 is refused with
*"only 2 are available (7 already awaiting approval)"*.

### Two-stage approval
Every request goes to **both** the manager and the admin, and either may act first:

```
Employee submits            → Pending
Manager approves            → Waiting for Admin      ─┐
Admin approves              → Approved                │  either order
Admin approves              → Waiting for Manager    ─┘
Manager approves            → Approved
Either one rejects          → Rejected  (immediately)
```

`status` keeps its original three values — `pending` / `approved` / `denied` — so nothing
that already reads it breaks. *Waiting for Admin* and *Waiting for Manager* are **derived**
from the two decision slots by `ta_leave_stage()` (mirrored in JS by `leaveStage()`), which
also means leave rows created before this migration still read correctly.

Guard rails, all enforced in `ta_review_leave()`: you can never review your own request,
you can never fill the same slot twice, and someone who is *both* an admin and a manager
fills one slot per call — so a single person still can't close a two-approver request in
one click. The approval dialog says which it is: **"Approve & pass on"** versus
**"This is the final approval — 4 day(s) will be deducted"**.

### The balance moves once, at the end
Only final approval touches `ta_leave_balances`, and it re-checks the balance at that
moment in case it shifted since submission. `Total` never changes:

| | Total | Used | Remaining |
|---|---|---|---|
| Before | 25 | 0 | 25 |
| 4 days requested, **pending** | 25 | 0 | 25 |
| After **final** approval | 25 | 4 | 21 |

Nobody — not even an admin — can `UPDATE` `ta_leave_requests` directly; the policy is
dropped and the grant revoked. Without that, an admin could PATCH `status` straight to
`approved` and the deduction would never run.

### Who reviews where
- **Admin → Leave Requests**: the full queue, bucketed *Awaiting you / In progress /
  Approved / Rejected*, plus an **Approval flow** card to toggle which approvers are
  required (at least one, enforced by a table CHECK).
- **Manager → Approvals**: managers stay in the employee shell and get an Approvals tab
  (in Chat's slot) plus a *More* entry. Same review card as the admin sees.

Both show employee name, leave type, from/to, day count, reason, current balance, the
attachment, the request status, and a two-step approval trail with each approver's note
and timestamp.

### Calendar
Approved leave shows in blue, pending leave in amber, alongside the existing present /
absent / off-day / today states, with a legend entry for each. Tapping a leave day shows
the type, span and reason, and marks pending days *"Not yet approved — this day is still
provisional."*

## 3d. Vacation balances (v4)

### Editing an allowance
*Admin → Vacation Balances* lists every member of staff with their total, used and remaining
days, split by leave type. **Edit balance** (or **Edit Vacation Balance** on the person's card
under *Employees*) opens one dialog with a field per leave type, pre-filled with what the
database currently holds, each showing how many days are already used. A reason is optional
and is kept with the change.

Only **Total** is editable. `used_days` comes from approved leave and is never typed in by a
human — `ta_review_leave()` is the only thing that moves it, on final approval. `remaining_days`
is a generated column, so it can never drift from `total − used`.

Only the types you actually changed are sent, and they are applied in **one transaction**: if
the medical figure is refused, the casual one is rolled back with it, so a half-applied edit
is not a state the admin can reach.

### It persists
The new total is written to `ta_leave_balances` in Supabase the moment you press Save. Nothing
about the balance is cached in the browser, so it survives a refresh, a logout and a fresh
sign-in, and it appears in the employee's own account the next time their screen loads. The
employee also gets a notification naming the old and new figures.

### A total can never go below days already used
Someone who has taken 4 casual days cannot be dropped to 2 — that would silently manufacture
negative remaining days. The dialog blocks it, and `ta_set_leave_balance()` re-checks it under
a row lock, so two admins editing at once cannot race past it and neither can a hand-built
PostgREST call.

### Employees cannot edit their own balance
This is enforced in the database, not the UI. `ta_leave_balances` has **no INSERT or UPDATE
policy at all** after v4 and the table grants are revoked, so PostgREST refuses the write to
*every* authenticated user — admins included — before RLS is even consulted. The only write
path is `ta_set_leave_balance(s)`, which raises unless `ta_is_admin()` is true. Employees keep
`SELECT` on their own row, which is what their balance rings read.

### Every change is recorded
`ta_balance_adjustments` stores the employee, leave type, before, after, days used at the time,
who made the change, the reason and the timestamp. The last five show inside the edit dialog;
the full history is one query:

```sql
select a.created_at, e.full_name as employee, a.leave_type,
       a.total_before, a.total_after, w.full_name as changed_by, a.note
  from public.ta_balance_adjustments a
  join public.ta_profiles e on e.id = a.employee_id
  left join public.ta_profiles w on w.id = a.changed_by
 order by a.created_at desc;
```

## 3e. Roles and passwords

`ta_role` is still just `employee` | `admin`. A job title — Engineer, Office Boy, Developer,
TeleSales Agent, Team Leader — lives in `ta_profiles.position` and **carries no permissions of
its own**, which is why adding people cannot widen anyone's access.

| Tier | Who | Reaches |
| --- | --- | --- |
| `admin` | **Ayman Madbouly** and **Mohamed Ayman** — and nobody else | Admin shell: Dashboard, Leave Requests, Employees, **Vacation Balances (view + edit)**, Off-Days, Weekend Changes, Rest Days, Geofence, Analytics, My Account |
| `employee` | Everyone else, whatever their job title | Employee shell only: clock in/out, own attendance, own leave, **own balance (read-only)**, calendar, notifications, More |

**There are exactly two administrators.** Mr Sayed is *employee · TeleSales · Team Leader* —
Team Leader is a job title with no permissions attached, the same as Engineer or Office Boy.
[`db/fix-admin-roles.sql`](db/fix-admin-roles.sql) enforces the two-admin rule and proves it.

`ta_profiles.role` is the single source of truth for this, in both directions:
`ta_is_admin()` is `select role = 'admin' from ta_profiles where id = auth.uid()`, every admin
RLS policy and admin RPC calls it, and the frontend guard in
[`js/app.js`](js/app.js) reads `state.profile.role` off the very same row it loads at boot. So
the database and the UI cannot disagree about who is an admin, and demoting someone in SQL
demotes them everywhere. A demoted user who is signed in at that moment keeps the admin
*screens* until they reload — but every admin write they attempt is refused, because
`ta_is_admin()` is evaluated per request, not per session.

### Change Password (v5)
Every authenticated user gets the same **Security** section in their settings screen —
employees at *More*, admins at *My Account*. It is one component,
[`js/pages/shared/security.js`](js/pages/shared/security.js), rendered by both shells, with
three fields: **Current Password**, **New Password**, **Confirm New Password**.

The order matters: the current password is **verified before anything changes**. GoTrue has no
"check my password" endpoint, so `auth.verifyPassword()` asks for a token using that password
and throws the result away — nothing is persisted, so a wrong guess cannot disturb the live
session and a right one cannot leave the app holding two. Only once it comes back true does
`auth.updatePassword()` run. A wrong current password therefore never reaches the update call
at all.

Each check has its own message, shown inline under the offending field *and* as a toast
through the existing `toastOk` / `toastErr` system: empty current, new shorter than 6, new
identical to current, confirmation mismatch, wrong current password. Anything GoTrue rejects
(too weak, same as old, rate-limited) is passed through in its own words, which are more
specific than anything the app could invent.

After a successful change the app signs in again with the new password, so the user **stays
logged in** on a fully valid session rather than being bounced at the next silent token
refresh. The fields are cleared and a success toast confirms it.

**Nobody can change anybody else's password.** `auth.changePassword(current, new)` takes no
"whose account" argument — the email comes from the live session — so there is no parameter to
tamper with, and no "set this person's password" control exists anywhere in the admin UI. An
admin who needs to reset someone else's uses **Authentication → Users** in the Supabase
dashboard, or the user uses *Forgot password?* on the login screen.

**No password is ever stored by this app.** Supabase Auth holds the bcrypt hash in
`auth.users.encrypted_password`; there is no password column on `ta_profiles` or any other
`ta_*` table, no password is written to a log, echoed into the DOM, or put in a URL, and the
fields are `type="password"` and cleared on success.

## 3f. Salary, shifts & payroll (v7)

### Clock-out verification
Clocking out is the one action an employee cannot undo, so it asks for a shared word first.
A modal appears **before** the clock-out is sent; the day only ends once `RingRoad` is typed.

The check is `input.trim().toLowerCase() === 'ringroad'`, so `RingRoad`, `ringroad`,
`RINGROAD`, `RiNgRoAd` and `  RingRoad  ` all pass, and anything else — including an empty
box or whitespace only — is refused with an inline error while the dialog **stays open**
(closing it would make a typo look like a cancelled clock-out). Nothing else about clocking
out changed: the same payload reaches the same `ta_clock_out()` RPC, which still re-checks the
geofence and still computes the minutes on the server.

### Shifts, grace and lateness
Each employee is assigned one of the three shifts (or given custom hours). Lateness is
measured from **their** shift start, in the company timezone from `ta_settings.timezone`:

```
late minutes     = clock_in (in Africa/Cairo) − shift start, floored at 0
billable minutes = late minutes − grace period, floored at 0
late deduction   = billable minutes × late rate     (optionally capped per day)
```

With a 10:00 shift and a 15-minute grace: **10:00, 10:10 and 10:15 are on time**; 10:16 is
1 billable minute (1 EGP); 10:30 is 15 billable minutes (15 EGP). Turning up on a day off or
a holiday is never penalised.

### Absence
A day costs money only when it is a **scheduled working day with no attendance**. The
classification order is: attendance → holiday → weekly day off → approved vacation → approved
rest day → a permission covering the whole shift → still in the future → *absent*. Approved
vacation, approved rest days, weekly days off and holidays therefore **never** produce a
deduction.

The daily rate is either `salary ÷ the employee's scheduled working days that month` (the
default — it respects their own days off and the holiday calendar, so a 23-working-day month
and a 26-working-day month price differently) or `salary ÷ a fixed month length`, per employee.

### Weekly days off
Seeded by role — **Sales get one day (Friday)**, developers and engineers get **Friday +
Saturday** — and editable per person in the rules dialog. They are stored in the existing
`ta_weekly_off_days`, so the calendar, the rest-day picker and the weekend-change flow all
keep reading the same schedule they always did.

### Payroll is derived, never stored
There is deliberately **no deductions table the app writes to on load**. `ta_payroll()`
recalculates the month from attendance every time it is called, so refreshing the dashboard a
hundred times produces the same numbers a hundred times — there is nothing to duplicate. The
only stored money rows are the manual *other deductions*, which an admin types in and which
carry a unique `(employee, month, lower(label))` index: re-entering the same charge edits it.

```
Net salary = base salary − (late + absence + permission + other deductions)
```

## 3g. Monthly leave permissions (v7)

**A leave permission is not a vacation.** Vacation (`ta_leave_requests`) is whole days,
deducts a balance and needs two-stage approval. A permission (`ta_leave_permissions`) is hours
inside one working day, deducts no balance, and most of them need no approval at all. They are
separate tables, separate RPCs and separate screens, and this migration does not touch the
vacation system.

### The rule
Every employee gets **3 permissions per calendar month** (configurable per employee):

| | |
| --- | --- |
| #1, #2, #3 | **Approved immediately**, `approval_type = automatic`. They never appear as Pending. |
| #4 and beyond | **Pending → Admin approval.** Never auto-rejected. |

The decision is made by `ta_request_permission()` **in the database**, from a count it runs
itself. The client sends a date, a window and a reason — nothing else — so an employee cannot
submit one pre-approved, and cannot change a status afterwards (no INSERT or UPDATE grant).

### The counter resets by itself
There is no counter column and nothing to reset. *Used* is
`count(status = 'approved') for permissions whose permission_date falls in that month`, so
September's 3/3 is October's 0/3 on the 1st, automatically. A rejected or cancelled request
gives the allowance back; a pending #4 has consumed nothing, because it may still be rejected.

### Statuses
`approved` · `pending` · `rejected` · `cancelled`, with `approval_type` recording whether an
approval was `automatic` or by an `admin`, plus `decided_at` / `decided_by` / `admin_note`.
An employee may cancel their own request while the day is still ahead; an admin may cancel any.

### Attendance and payroll
An approved permission is attached to its date and shown there — on the employee's calendar
day detail, on the admin dashboard's *Approved Leave Permissions Today*, on each person's
history under **Employees**, and in the payroll day-by-day table. It is never read as an
absence, and a permission that covers the **entire** shift excuses the day outright rather
than counting as one.

**No deduction by default.** An approved permission costs nothing unless an admin switches
*Deduct pay for approved permissions* on for that specific employee, and then chooses the
method: **per minute**, **per permission**, or a **fixed monthly** charge.

## 4. Security (defence in depth)

Row Level Security is enabled on every table. Employees can read **only their own**
attendance, leave requests, balances, notifications and profile; admins see all. Approvals
run through the `ta_review_leave` RPC so balance math can't be tampered with from the client.
Frontend route guards are a convenience only — the database is the real gate.

The v2 tables go further: employees hold **`SELECT` only** on
`ta_weekend_change_requests`, `ta_rest_day_requests`, `ta_rest_balances` and
`ta_geo_attempts`, and employees' direct `INSERT`/`UPDATE` on `ta_attendance` is revoked.
Every write happens inside a `SECURITY DEFINER` RPC that re-validates the rule, takes a
row lock where two parallel calls could race (the last weekend slot, the last rest day),
and is the only path that exists. `ta_settings.geofence_radius_m` additionally carries a
`CHECK (between 100 and 200)`, so even an admin PATCHing the table directly cannot set an
out-of-range radius.

v3 tightens two more things. Employees lose `INSERT` on `ta_leave_requests` and *nobody*
retains `UPDATE`, so the "deduct only on final approval" rule has no bypass. And a trigger
closes a pre-existing privilege-escalation hole: `ta_prof_upd` allows `id = auth.uid()`,
which also let any user set their own `role = 'admin'` — changing `role` or `is_manager`
now requires an admin (or a direct database session, so seeding still works).

v4 applies the same rule to vacation balances. `ta_leave_balances` keeps **no INSERT or
UPDATE policy at all** and its write grants are revoked, so PostgREST refuses the write to
every authenticated user — including admins — before RLS is consulted. The only write paths
are `ta_set_leave_balance(s)` (admin-gated, re-checks the used-days floor under a row lock,
records the change) and `ta_review_leave()` (the only thing that touches `used_days`). An
employee therefore cannot alter their own allowance, and an admin cannot alter one without
leaving a trace in `ta_balance_adjustments`. `db/fix-grants.sql` was updated to match: it no
longer re-grants write on `ta_leave_balances` or `ta_leave_requests`, which would otherwise
have quietly reopened both holes the next time somebody ran it.

v7 extends that pattern to money. `ta_salary_rules`, `ta_payroll_adjustments`, `ta_shifts`,
`ta_holidays` and `ta_leave_permissions` have **no INSERT/UPDATE/DELETE policy and no write
grant** for `authenticated`, so a crafted PostgREST call from DevTools is refused with a
Postgres 42501 before RLS is even consulted — for admins too. Every change goes through a
`SECURITY DEFINER` function that calls `ta_is_admin()` first and re-validates every bound
server-side, so no salary, grace period, shift, day off or approval status can be set from the
browser. Reads are equally narrow: `ta_salary_rules` and `ta_payroll_adjustments` are visible
only to their own employee and to admins — **a manager sees nothing here**, because approving
leave never requires seeing a colleague's pay — and `ta_payroll()` raises *"You can only view
your own payroll"* for any `employee_id` other than the caller's unless the caller is an admin.
The one write an employee can trigger is `ta_request_permission()`, which decides the status
itself from a count it runs in the database; the request carries a date, a window and a reason
and nothing more, so "approved" is not something a client can ask for.

Payroll arithmetic is likewise never trusted to the browser. Every figure on the Payroll and
My Salary screens comes back from `ta_payroll()`; the frontend only formats it.

**Honest limitation:** a determined user on a rooted/jailbroken device or with a mock-location
app can feed the browser false coordinates — no browser-based geofence can rule that out.
What the server does guarantee is that the coordinates it *was* given are the ones it
judged, that the verdict and radius are its own, and that every attempt is recorded for an
admin to review.

## 5. Realtime

Live views (admin "Who's In", employee unread badge) use lightweight **polling** (20s,
`POLL_MS` in `config.js`) so there are zero extra dependencies. The three high-traffic tables
are already added to the `supabase_realtime` publication, so you can swap polling for
websocket subscriptions later without a schema change.

## 6. Deployment

It's a static site — deploy the `attendance-app/` folder to **Netlify, Vercel, Cloudflare
Pages, or GitHub Pages** (no build command; publish directory = `attendance-app`).

Because there's no bundler, `config.js` is a real file rather than a build-time env var.
Two clean options:
1. Commit a `config.js` containing only the **anon** key (safe — RLS-protected), or
2. Generate it at deploy time from platform env vars, e.g. a one-line predeploy step:
   `echo "export const SUPABASE_URL='$SUPABASE_URL'; export const SUPABASE_ANON_KEY='$SUPABASE_ANON_KEY'; export const SESSION_KEY='rr_attendance_session'; export const POLL_MS=20000;" > config.js`

For Google login: enable the Google provider in **Supabase → Authentication → Providers** and
add your deployed URL to the redirect allow-list.

## 7. Test checklist

1. Log in as employee → **Clock In** → confirm row in `ta_attendance` (Supabase table editor).
2. Watch the live timer → **Clock Out** → `total_minutes` + `status='completed'` persist.
3. **Apply for Leave** → appears in *My Leaves* as **Pending**; balance unchanged.
4. Log in as admin → **Leave Requests** shows it → **Approve**.
5. Verify: request → **Approved**, `ta_leave_balances.used_days` increased, employee gets a
   notification, and the employee's *My Leaves* / balance reflect it (auto-refresh ≤ 20s).
6. Repeat with **Deny** → status Denied, balance unchanged, notification sent.
7. Set an employee's **off-days** → confirm the calendar marks those days as off.
8. Resize to mobile/tablet/desktop → layouts adapt (bottom nav ↔ sidebar).
9. Log out / back in → session restore works.

**v2 checklist**

10. **Weekend #1** → applied instantly, status *Auto-approved*, off-days change, 1 left.
11. **Weekend #2** → status *Pending*; admin approves → off-days change; admin rejects →
    the slot frees up and the employee can submit a different one.
12. **Weekend #3** → refused ("You have used all 2 of your weekend changes").
13. **Rest days within balance** → submitted as Pending; the available count drops by the
    reserved days immediately.
14. **Rest days over balance** → the picker won't select past the limit, and a hand-built
    `ta_request_rest_days` call is refused with "You do not have enough available rest days".
15. **Clock In inside 150 m** → allowed; row carries lat/lng/distance/radius/result.
16. **Clock In outside the radius** → blocked with the standard message plus your distance;
    a `ta_geo_attempts` row is written with `passed = false`.
17. **Clock Out inside / outside** → same rule, same log.
18. **Deny location permission** → clear message + per-browser fix instructions, no crash.
19. **Bypass attempt** → `POST /rest/v1/ta_attendance` as an employee returns 401/403
    (policy), and `rpc/ta_clock_in` with off-site coordinates returns `ok: false`.
20. **Admin → Geofence** → move the radius slider (bounded 100–200 m) and save; the new
    radius applies to the next clock in/out.

**v3 checklist — leave workflow**

21. Home shows **no Rest Days card**; Leave Balance, *View all*, *Apply Leave* and
    *Calendar* are all unchanged. (Rest Days still lives at *More → Rest Days*.)
22. **25 Aug → 28 Aug** shows **4 days**. A To Date before the From Date, and a start date
    in the past, both block submission with an inline message.
23. Request **more days than remain** → blocked, with the shortfall named. Trimming the
    request in devtools and calling `rpc/ta_request_leave` directly → refused too.
24. **Submit** → status *Pending*, and Total/Used/Remaining are **unchanged**.
25. **Manager approves** → *Waiting for Admin*, balance still unchanged.
26. **Admin approves** → *Approved*; Used +N, Remaining −N, Total the same.
27. Reverse the order — **admin first** → *Waiting for Manager* → manager approves →
    *Approved*. Same result.
28. **Either approver rejects** → *Rejected* immediately, balance untouched.
29. An approver **cannot review their own request**, and cannot fill the same slot twice.
    Someone who is both admin and manager needs two separate approvals.
30. **Calendar** shows approved leave in blue and pending leave in amber, each in the legend.
31. Attach a PDF/image to a **Medical** request → the approver can open it from the review
    card via a short-lived signed URL.
32. With **no managers assigned**, the admin Leave Requests screen shows the warning banner
    and offers the manager-approval toggle as the fix.

**v4 checklist — vacation balances**

33. Log in as **admin** → **Vacation Balances** → every member of staff is listed with Total,
    Used, Remaining and a per-type breakdown, and each row has **Edit balance**.
34. **Edit balance** → change Casual to a new number → **Save balance** → the toast confirms
    and the table shows the new figure.
35. **Refresh the page (F5)** → the new figure is still there. **Log out and back in** → still
    there. (It is read from `ta_leave_balances` every time; nothing is cached client-side.)
36. Log in as **that employee** → Home shows the new allowance on the balance rings, and a
    notification names the old and new values.
37. Try to set a total **below the days already used** → refused in the dialog, and refused
    again by `rpc/ta_set_leave_balance` if you call it directly.
38. As an **employee**, `PATCH /rest/v1/ta_leave_balances?id=eq.<own row>` → refused (no policy
    + no grant). `rpc/ta_set_leave_balance` as an employee → *"Only an admin can change a
    vacation balance"*. Both hold for an admin's raw PATCH too.
39. **Employees → a person → Edit Vacation Balance** opens the same dialog and saves the same way.
40. `select * from ta_balance_adjustments order by created_at desc` → one row per change, with
    the before/after totals, the admin who made it and the reason.
41. **Mr Sayed** logs in → lands on the **employee** app, not the Admin Dashboard. Typing
    `#/admin` bounces him back to `#/home`, and `rpc/ta_set_leave_balance` refuses him. He
    changes his own password from **More → Security**, like every other employee.
42. Apply for leave and approve it → `used_days` rises and Remaining falls, while **Total stays
    at whatever the admin set**.

**v5 checklist — Ayman Madbouly + Change Password**

43. Run `db/fix-ayman-admin.sql`. Its verification query returns one row with `role = admin`,
    `email_confirmed_ok`, `can_password_login_ok` and `has_password_ok` all true, and
    `balance_rows_expect_3` = 3.
44. **Ayman Madbouly signs in** → lands on the **Admin Dashboard**, not the employee app.
45. He opens **Vacation Balances**, edits somebody's allowance and saves → it persists.
46. A **regular employee** signing in gets the employee shell; typing `#/admin` in the address
    bar bounces them back to `#/home`, and `rpc/ta_set_leave_balance` refuses them.
47. **Every user** — admin or employee — finds **Security → Change Password** in their
    settings screen with all three fields.
48. Wrong **current** password → *"Your current password is incorrect"*, and the network tab
    shows **no** `PUT /auth/v1/user`: the password was never touched.
49. Mismatched confirmation, a new password under 6 characters, and a new password identical
    to the current one are each refused with their own message, before any request is sent.
50. A valid change → success toast, fields cleared, and **you are still logged in**.
51. **Log out and back in with the new password** → works. The old one is rejected.
52. `select * from auth.users` → `encrypted_password` is a bcrypt hash; no plain-text password
    exists in `auth.users` or in any `ta_*` table.

**v6 checklist — exactly two admins**

53. Run `db/fix-admin-roles.sql`. Its `DEMOTED to employee` block lists anyone who lost the
    role; on a second run that block is empty.
54. The requirement's own query returns **exactly two rows** — Ayman Madbouly and Mohamed
    Ayman:
    ```sql
    select full_name, email, role from public.ta_profiles where role = 'admin';
    ```
55. The PASS/FAIL block reads **PASS**, and `ayman_madbouly_is_admin`, `mohamed_ayman_is_admin`,
    `no_other_admins` and `exactly_two` are all **true**.
56. **Mr Sayed** reads `employee · TeleSales · Team Leader` on both candidate addresses, and no
    third Sayed account was created.
57. **Both admins** sign in → Admin Dashboard → **Vacation Balances** → edit and save a
    balance → it persists.
58. **Any other user** (Sherif, Peter, Mostafa, Mr Sayed) signs in → employee app only;
    `#/admin` redirects to `#/home`; `rpc/ta_set_leave_balance` returns *"Only an admin can
    change a vacation balance"*.
59. **Password change still works for everyone**, admin and employee alike — this migration
    touches only the `role` column.

**v7 checklist — clock-out verification**

60. **Clock Out** → a *Confirm clock out* modal appears **before** anything is sent.
61. `RingRoad`, `ringroad`, `RINGROAD`, `RiNgRoAd` and `  RingRoad  ` (padded) each close the
    modal and complete the clock-out. Verified in the browser — all five pass.
62. Random text, a near-miss like `RingRoads`, an **empty** box and **whitespace only** are all
    refused with an inline error, the field turns red, and the modal **stays open**. No RPC is
    sent and the day is not ended. Verified — all four refused, `onVerified` never fired.
63. **Cancel** closes the modal and leaves the employee clocked in.
64. Everything downstream is unchanged: geofence checks, `total_minutes`, `status='completed'`
    and the "already clocked out" guard all behave exactly as in step 2.

**v7 checklist — salary rules**

65. **Admin → Salary & Rules** → the three shifts read *09:00–17:00 · 10:00–18:00 ·
    11:00–19:00*, and the company defaults show `Africa/Cairo`, 6000 EGP, 15 min, 1 EGP/min,
    3 permissions.
66. Every employee has a row with a salary, a shift, a grace period, a late rate, an absence
    rule, a permission allowance, days off and Active/Inactive.
67. Fresh install → **Sales get Friday only**; developers and engineers get **Friday +
    Saturday**. An employee who already had off-days keeps them (the backfill only seeds
    people with none).
68. **Edit rules** → change a salary, shift, grace period and days off → save → the table and
    the employee's own screen both show the new values, and the employee gets a
    *Work rules updated* notification.
69. Assign **Shift 2 (10:00)** with a **15 min** grace, then check lateness:
    | Clock in | Result |
    | --- | --- |
    | 10:00 / 10:10 / 10:15 | On time, **0 EGP** |
    | 10:16 | 1 billable minute → **1 EGP** |
    | 10:30 | 15 billable minutes → **15 EGP** |
70. **Timezone** — a clock-in stored as `08:16Z` is judged as 10:16 Cairo, not 08:16, whatever
    the admin's browser is set to.

**v7 checklist — absence, vacation and payroll**

71. A **weekly day off** with no attendance → *Day Off*, **no** absence deduction. Same for a
    **company holiday** added under Salary & Rules.
72. A day covered by **approved vacation** → *Vacation*, **no** absence deduction. An approved
    **rest day** → likewise.
73. A scheduled working day with no attendance and no cover → *Absent*, deducted at
    `salary ÷ scheduled working days` (shown in full in the breakdown).
74. **Admin → Payroll** → pick a month → every employee shows base, working days, present,
    late days, late minutes, late deduction, absence days, absence deduction, permissions,
    other, total deductions and net salary.
75. **Net salary = base − total deductions.** With a 6000 EGP base, 30 EGP of lateness and one
    absent day at 260.87 EGP, the row reads **5,709.13 EGP**.
76. **Breakdown** → a dated line per late day (*"Sep 3 — 20 billable minutes → 20 EGP"*), per
    absence, per permission and per manual deduction, plus a day-by-day table.
77. **Idempotence** — refresh Payroll ten times, reopen the breakdown, switch months and come
    back: **the figures never change and no deduction is duplicated.** (Nothing is written on
    load; `ta_payroll()` derives the month every call.)
78. **Add another deduction** with the *same label* twice → the amount is **updated**, not
    added twice (unique on employee + month + label).
79. **Employee → More → My Salary & Schedule** → their shift, grace period, days off, monthly
    salary, each deduction with its reason, and the current estimated net salary.
80. `rpc/ta_payroll` with **another employee's id** from an employee session → *"You can only
    view your own payroll"*. `PATCH /rest/v1/ta_salary_rules` from any session, employee or
    admin → **42501 permission denied**. `rpc/ta_set_salary_rules` from an employee → *"Only
    admins can change salary and attendance rules"*.

**v7 checklist — leave permissions**

81. **Employee → Leave Permissions** → the counter reads `Used 0 / 3`, *3 left this month*.
82. Submit **#1**, **#2** and **#3** → each is **Approved immediately**, `approval_type` =
    `automatic`, none of them ever shows as Pending, and the counter walks 1/3 → 2/3 → 3/3.
83. Submit **#4** → status **Pending Admin Approval** (not rejected), the employee is told an
    admin must approve it, and every admin gets a notification.
84. **Admin → Leave Permissions** → #4 appears under *Requires approval* with the employee,
    date, start, end, duration, reason, status and *beyond their 3 / month*. Approve → the
    employee is notified and the row reads *Admin approved*; reject → *Rejected* with the note.
85. **History** (admin) and the employee's own list both group by calendar month with
    `Used n / 3` per month.
86. **Monthly reset** — a permission dated in the next month counts against that month:
    September at 3/3 shows October at **0/3** with nothing to reset by hand.
87. **Cancel** an approved permission → it returns to the allowance (`Used` drops by one).
88. An approved permission on a working day: **not** an absence, shown on the employee's
    calendar day detail, in the admin **Employees** history for that date, on the dashboard's
    *Approved Leave Permissions Today*, and in the payroll day-by-day table.
89. With **Deduct pay for approved permissions** OFF (the default) → an approved permission
    costs **0 EGP**. Switch it on at 0.50 EGP per minute → a 60-minute permission deducts
    **30 EGP**, and the breakdown says why.
90. `POST /rest/v1/ta_leave_permissions` from an employee session → **42501**; they cannot
    create a row at all, let alone one with `status = 'approved'`.
    `rpc/ta_review_permission` from an employee → *"Only admins can decide leave permissions"*.
91. **Vacation still works end to end** — request, manager + admin approval, balance deduction,
    remaining days, weekend changes and rest days are all unchanged by this migration.
```

**Verified already:** the app boots with zero console errors, all 38 modules load, the login
screen renders, and live auth is wired (bad credentials return the correct "Wrong email or
password" error from Supabase). For v7 specifically: the clock-out verification word was
exercised in the browser against all six cases in steps 61–62 and behaves exactly as
specified, and the new **Payroll**, **Salary & Rules**, **Leave Permissions**, **My Salary**
and employee **Leave Permissions** screens were each rendered against representative data on
desktop and mobile. What could **not** be exercised without the live database is the SQL
itself — `db/schema-v7.sql` has to be run in the Supabase dashboard (step 2b8), because DDL
can't be executed with the public anon key, and steps 65–91 need it in place.
