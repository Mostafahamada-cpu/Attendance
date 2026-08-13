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
│   └── seed.sql            # role promotion + demo off-days (edit emails)
└── js/
    ├── app.js              # session, routing, employee + admin shells
    ├── lib/                # supabase · data · ui · time · toast
    └── pages/
        ├── login.js
        ├── employee/       # home · apply-leave · my-leaves · calendar · notifications · chat · more
        └── admin/          # dashboard · leaves · employees · balances · offdays · analytics
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

**Admin (desktop-first, responsive):** KPI dashboard (present / working / not-in / pending /
team) · live "Who's In Right Now" (polls every 20s) · leave requests with **Approve/Deny →
balance auto-updates + notification** · employee drill-down (calendar stats, history, weekly
pattern) · team leave-balance table with search & smart filters · per-employee weekly off-day
editor · analytics (today/week/month/custom → total & avg hours, attendance rate, late
arrivals, absences, daily-hours chart).

## 4. Security (defence in depth)

Row Level Security is enabled on every table. Employees can read/write **only their own**
attendance, leave requests, balances, notifications and profile; admins see all. Approvals
run through the `ta_review_leave` RPC so balance math can't be tampered with from the client.
Frontend route guards are a convenience only — the database is the real gate.

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
```

**Verified already:** the app boots with zero console errors, all 20 modules load, the login
screen renders, and live auth is wired (bad credentials return the correct "Wrong email or
password" error from Supabase). The only step that must be done in the Supabase dashboard is
running `db/schema.sql` (step 2b) — DDL can't be executed with the public anon key.
