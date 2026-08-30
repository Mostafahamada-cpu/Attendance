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
│   ├── provision-users-v2.sql  # ← the seven new/updated users (run after v4)
│   ├── fix-ayman-admin.sql     # ← makes Ayman Madbouly an active admin
│   └── seed.sql            # role promotion + demo off-days (edit emails)
└── js/
    ├── app.js              # session, routing, employee + admin shells
    ├── lib/                # supabase · data · ui · time · toast · geo · storage
    └── pages/
        ├── login.js
        ├── shared/         # leave-review · security (Change Password, both shells)
        ├── employee/       # home · apply-leave · my-leaves · calendar · notifications ·
        │                   #   chat · more · weekend · rest-days · approvals (managers)
        └── admin/          # dashboard · leaves · employees · balances · offdays ·
                            #   weekend · rest-days · geofence · analytics · account
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
Mostafa, promotes **Mr Sayed** to admin, and confirms the two Ayman admin accounts. It is
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

| Tier | Reaches |
| --- | --- |
| `admin` | Admin shell: Dashboard, Leave Requests, Employees, **Vacation Balances (view + edit)**, Off-Days, Weekend Changes, Rest Days, Geofence, Analytics, My Account |
| `employee` | Employee shell only: clock in/out, own attendance, own leave, **own balance (read-only)**, calendar, notifications, More |

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
41. **Mr Sayed** logs in → lands on the **Admin Dashboard** → sidebar footer → **My Account** →
    **Change Password** → sets a new password → logs out → signs in with the new one.
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
```

**Verified already:** the app boots with zero console errors, all 20 modules load, the login
screen renders, and live auth is wired (bad credentials return the correct "Wrong email or
password" error from Supabase). The only step that must be done in the Supabase dashboard is
running `db/schema.sql` (step 2b) — DDL can't be executed with the public anon key.
