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
│   └── seed.sql            # role promotion + demo off-days (edit emails)
└── js/
    ├── app.js              # session, routing, employee + admin shells
    ├── lib/                # supabase · data · ui · time · toast · geo
    └── pages/
        ├── login.js
        ├── employee/       # home · apply-leave · my-leaves · calendar · notifications ·
        │                   #   chat · more · weekend · rest-days
        └── admin/          # dashboard · leaves · employees · balances · offdays ·
                            #   weekend · rest-days · geofence · analytics
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

**Admin (desktop-first, responsive):** KPI dashboard (present / working / not-in / pending /
team) · live "Who's In Right Now" (polls every 20s) · leave requests with **Approve/Deny →
balance auto-updates + notification** · employee drill-down (calendar stats, history, weekly
pattern) · team leave-balance table with search & smart filters · per-employee weekly off-day
editor · analytics (today/week/month/custom → total & avg hours, attendance rate, late
arrivals, absences, daily-hours chart).

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
```

**Verified already:** the app boots with zero console errors, all 20 modules load, the login
screen renders, and live auth is wired (bad credentials return the correct "Wrong email or
password" error from Supabase). The only step that must be done in the Supabase dashboard is
running `db/schema.sql` (step 2b) — DDL can't be executed with the public anon key.
