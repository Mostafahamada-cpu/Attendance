#!/usr/bin/env python3
"""
RingRoad Attendance — credentials PDF generator.

Reads db/credentials-input.csv and produces a professional PDF:
    Name | Department/Role | Email | Password

The PDF also documents what each access tier can do, including the
Admin Vacation Balance Management feature added in schema-v4.

RULES (by design — never fabricates passwords):
  * status=existing  -> the password column MUST be filled with the user's REAL
    existing RingRoad password. If ANY existing row is blank, the script STOPS,
    lists the missing users, and writes NO PDF. Existing passwords are used
    verbatim and are never changed/reset.
  * status=new       -> if the password is blank, a strong temporary password is
    generated; otherwise the provided value is used as-is.

There is NO "Use existing RingRoad password" placeholder anywhere.

Usage:  python db/make-credentials-pdf.py
Output: ../Attendance-Credentials.pdf  (repo root, outside the deployed app)
"""
import csv, os, sys, secrets
from xml.sax.saxutils import escape as xml_escape

HERE = os.path.dirname(os.path.abspath(__file__))
CSV_IN = os.path.join(HERE, "credentials-input.csv")
PDF_OUT = os.path.normpath(os.path.join(HERE, "..", "..", "Attendance-Credentials.pdf"))

SYM = "!@#$%&*"
WORDS = ["Falcon","Cedar","Harbor","Cobalt","Summit","Delta","Orbit","Quartz","Maple",
         "Nimbus","Vertex","Zephyr","Lumen","Onyx","Pilot","Raven","Terra","Sable"]
def gen_pw():
    return (f"{secrets.choice(WORDS)}{secrets.choice(SYM)}{secrets.randbelow(900)+100}"
            f"{secrets.choice(SYM)}{secrets.choice('ABCDEFGHJKMNPQRSTUVWXYZ')}"
            f"{secrets.choice('ABCDEFGHJKMNPQRSTUVWXYZ')}")

def load_rows():
    if not os.path.exists(CSV_IN):
        sys.exit(f"ERROR: input file not found: {CSV_IN}")
    with open(CSV_IN, newline="", encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if r.get("email", "").strip()]
    missing, out = [], []
    for r in rows:
        name = r["name"].strip(); role = r["role"].strip()
        email = r["email"].strip(); status = (r.get("status") or "").strip().lower()
        pw = (r.get("password") or "").strip()
        if status == "existing":
            if not pw:
                missing.append((name, email)); continue
        else:  # new
            status = "new"
            if not pw:
                pw = gen_pw()
        out.append(dict(name=name, role=role, email=email, status=status, password=pw))
    return out, missing

def build_pdf(rows):
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

    TEAL = colors.HexColor("#24AAA5"); TEAL_D = colors.HexColor("#16716D")
    INK = colors.HexColor("#14201F"); MUT = colors.HexColor("#6B7A7C")
    TEAL_BG = colors.HexColor("#E7F6F5"); ROW = colors.HexColor("#F4F8F8")
    ss = getSampleStyleSheet()
    H  = ParagraphStyle('H', parent=ss['Normal'], fontName='Helvetica-Bold', fontSize=20, textColor=colors.white, leading=24)
    SUB= ParagraphStyle('SUB', parent=ss['Normal'], fontName='Helvetica', fontSize=9.5, textColor=colors.HexColor("#D9F2F0"), leading=13)
    body=ParagraphStyle('body', parent=ss['Normal'], fontName='Helvetica', fontSize=9, textColor=INK, leading=13)
    note=ParagraphStyle('note', parent=ss['Normal'], fontName='Helvetica', fontSize=8.3, textColor=MUT, leading=12)
    cell=ParagraphStyle('cell', parent=ss['Normal'], fontName='Helvetica', fontSize=8.7, textColor=INK, leading=11)
    cellb=ParagraphStyle('cellb', parent=ss['Normal'], fontName='Helvetica-Bold', fontSize=8.7, textColor=INK, leading=11)
    mono=ParagraphStyle('mono', parent=ss['Normal'], fontName='Courier-Bold', fontSize=9, textColor=TEAL_D, leading=11)
    hdr=ParagraphStyle('hdr', parent=ss['Normal'], fontName='Helvetica-Bold', fontSize=8.5, textColor=colors.white, leading=11)
    H2 = ParagraphStyle('H2', parent=ss['Normal'], fontName='Helvetica-Bold', fontSize=12.5, textColor=TEAL_D, leading=16)
    bullet = ParagraphStyle('bullet', parent=ss['Normal'], fontName='Helvetica', fontSize=8.8,
                            textColor=INK, leading=12.6, leftIndent=9, spaceAfter=3.5)

    def band(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(TEAL); canvas.rect(0, A4[1]-32*mm, A4[0], 32*mm, fill=1, stroke=0)
        canvas.setFillColor(colors.white); canvas.circle(20*mm, A4[1]-16*mm, 6.2*mm, fill=1, stroke=0)
        canvas.setFillColor(TEAL); canvas.setFont('Helvetica-Bold', 12); canvas.drawCentredString(20*mm, A4[1]-18.2*mm, "RR")
        canvas.setFillColor(colors.HexColor("#0E5754")); canvas.setFont('Helvetica', 7.5)
        canvas.drawRightString(A4[0]-15*mm, 10*mm, "Confidential — distribute securely. Page %d" % doc.page)
        canvas.restoreState()

    doc = SimpleDocTemplate(PDF_OUT, pagesize=A4, topMargin=38*mm, bottomMargin=16*mm,
                            leftMargin=15*mm, rightMargin=15*mm, title="RingRoad Attendance — Account Credentials")
    import datetime
    el = [Paragraph("Attendance &amp; Time-Off — Account Credentials", H),
          Paragraph(f"RingRoad internal · Generated {datetime.date.today():%B %d, %Y} · {len(rows)} accounts", SUB),
          Spacer(1, 8),
          Paragraph("Log in with the email and password below. Admin accounts open the management "
                    "dashboard; all others open the employee app. Please change your password after "
                    "first sign-in — every user has a <b>Security → Change Password</b> section in "
                    "their settings screen (employees under <b>More</b>, administrators under "
                    "<b>My Account</b>).", body), Spacer(1, 10)]

    # ---- Change password --------------------------------------------------
    el.append(Paragraph("Changing your password", H2))
    el.append(Spacer(1, 5))
    el.append(Paragraph(
        "Open your settings screen and find the <b>Security</b> section. Enter your "
        "<b>Current Password</b>, then your <b>New Password</b> twice, and press "
        "<b>Change Password</b>.", body))
    el.append(Spacer(1, 6))
    for line in [
        "Your current password is <b>checked first</b>. If it is wrong, nothing changes and the "
        "form says so — the new password is never sent.",
        "The new password must be at least 6 characters, must match the confirmation, and must "
        "differ from your current one. Each problem is reported separately.",
        "The change is saved in <b>Supabase Authentication</b>. You stay signed in on the device "
        "you changed it on, and the new password works from the next sign-in onwards.",
        "<b>You can only change your own password.</b> There is no screen anywhere in the app — "
        "admin included — that sets somebody else's. If you are locked out, ask an "
        "administrator to reset it from the Supabase dashboard, or use <b>Forgot password?</b> on "
        "the login screen.",
        "Passwords are stored only as a hash by Supabase Authentication. This document is the "
        "only place a readable password appears — which is why it must be handled carefully.",
    ]:
        el.append(Paragraph("•&nbsp;&nbsp;" + line, bullet))
    el.append(Spacer(1, 12))

    # ---- What's new: admin vacation balance management --------------------
    el.append(Paragraph("New — Admin Vacation Balance Management", H2))
    el.append(Spacer(1, 5))
    el.append(Paragraph(
        "Administrators can now see and correct every employee's vacation allowance from inside the "
        "app. It lives on the <b>Vacation Balances</b> screen, and on each person's card under "
        "<b>Employees</b>.", body))
    el.append(Spacer(1, 6))
    for line in [
        "<b>View</b> — the Vacation Balances table lists every member of staff with their total, "
        "used and remaining days, broken down into Casual, Medical and Planned leave.",
        "<b>Edit</b> — the <b>Edit Vacation Balance</b> button opens a dialog where the admin types "
        "the correct number of available days for each leave type, with an optional reason for the change.",
        "<b>Saved to the database</b> — pressing Save writes the new allowance to Supabase straight "
        "away. It survives a refresh, a logout and a new sign-in, because nothing is kept in the browser.",
        "<b>Visible to the employee</b> — the new balance appears in that person's own account the "
        "next time their screen loads, and they receive a notification telling them what changed.",
        "<b>Employees cannot edit their own balance.</b> The balance table is read-only for every "
        "employee; only an administrator can change an allowance, and every change is recorded with "
        "who made it and when.",
        "<b>Existing leave rules are unchanged.</b> Days already used cannot be erased by lowering a "
        "total, and used days still move only when a leave request is finally approved.",
    ]:
        el.append(Paragraph("•&nbsp;&nbsp;" + line, bullet))
    el.append(Spacer(1, 12))

    # ---- Roles legend -----------------------------------------------------
    el.append(Paragraph("Roles &amp; access", H2))
    el.append(Spacer(1, 5))
    roles = [[Paragraph("Access tier", hdr), Paragraph("Roles in this list", hdr), Paragraph("What they can reach", hdr)],
             [Paragraph("Admin", cellb),
              Paragraph("Admin, Management", cell),
              Paragraph("Admin Dashboard, Employees, <b>Vacation Balances (view + edit)</b>, Leave Requests, "
                        "Off-Days, Weekend Changes, Rest Days, Geofence, Analytics, and My Account "
                        "(own password).", cell)],
             [Paragraph("Employee", cellb),
              Paragraph("TeleSales, Engineer, Office Boy, Developer, Team Leader", cell),
              Paragraph("Employee app only: clock in/out, own attendance and calendar, apply for leave, "
                        "own leave history, own vacation balance (<b>read-only</b>), notifications, and "
                        "More → Change Password.", cell)]]
    rt = Table(roles, colWidths=[22*mm, 46*mm, 100*mm])
    rt.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), TEAL_D), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6), ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, ROW]),
        ('BOX', (0, 0), (-1, -1), 0.6, TEAL), ('LINEBELOW', (0, 0), (-1, -1), 0.4, colors.HexColor("#E1E9E9"))]))
    el.append(rt)
    el.append(Spacer(1, 6))
    el.append(Paragraph("A job title (Engineer, Office Boy, Developer, TeleSales) is a label only — it "
                        "carries no permissions of its own. Access is decided solely by the access tier, "
                        "so the tier column below is the one that matters.", note))
    el.append(Spacer(1, 14))

    el.append(Paragraph("System users", H2))
    el.append(Spacer(1, 5))

    data = [[Paragraph("#",hdr),Paragraph("Name",hdr),Paragraph("Department / Role",hdr),
             Paragraph("Email",hdr),Paragraph("Password",hdr)]]
    admin_idx = []
    for i, r in enumerate(rows, 1):
        rl = r["role"].strip().lower()
        is_admin = ("admin" in rl) or ("management" in rl)
        if is_admin: admin_idx.append(i)
        role = r["role"] + ("  •  ADMIN" if is_admin else "")
        # reportlab Paragraphs parse their text as markup, so every value that
        # comes from the CSV must be escaped. Passwords are the reason: one
        # containing "&" (e.g. Sable&888&HP) was being mangled into an entity.
        data.append([Paragraph(str(i),cell), Paragraph(xml_escape(r["name"]),cellb),
                     Paragraph(xml_escape(role),cell), Paragraph(xml_escape(r["email"]),cell),
                     Paragraph(xml_escape(r["password"]), mono)])
    t = Table(data, colWidths=[8*mm,32*mm,34*mm,50*mm,44*mm], repeatRows=1)
    style = [('BACKGROUND',(0,0),(-1,0),TEAL),('VALIGN',(0,0),(-1,-1),'MIDDLE'),
             ('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5),
             ('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),
             ('LINEBELOW',(0,0),(-1,-1),0.4,colors.HexColor("#E1E9E9")),
             ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, ROW]),('BOX',(0,0),(-1,-1),0.6,TEAL)]
    for a in admin_idx: style.append(('BACKGROUND',(0,a),(-1,a),TEAL_BG))
    t.setStyle(TableStyle(style)); el.append(t)

    el.append(Spacer(1,14))
    el.append(Paragraph("Two people named Nada are separate accounts: <font face='Courier'>nada@ringroad.re</font> "
                        "(TeleSales) and <font face='Courier'>nada.eng@ringroad.re</font> (Engineer). "
                        "Existing RingRoad logins keep their current password (unchanged); accounts marked as new "
                        "use the temporary password shown and should change it after first sign-in. "
                        "Keep this document confidential.", note))
    el.append(Spacer(1, 6))
    el.append(Spacer(1, 6))
    el.append(Paragraph("<b>Ayman Madbouly</b> (<font face='Courier'>ayman.madbouly@ringroad.re</font>) and "
                        "<b>Mohamed Ayman</b> are administrators: they sign in to the Admin Dashboard and can "
                        "view and edit every employee's vacation balance.", note))
    el.append(Spacer(1, 6))
    el.append(Paragraph("<b>Mr. Sayed</b> is an administrator as well as the TeleSales team leader: he opens the "
                        "Admin Dashboard, can edit vacation balances, and changes his own password at "
                        "<b>My Account → Change Password</b>. An administrator can never set another person's "
                        "password from the app — each account changes its own.", note))
    doc.build(el, onFirstPage=band, onLaterPages=band)

def main():
    rows, missing = load_rows()
    if missing:
        print("STOP — will NOT generate a PDF. Missing REAL existing passwords for these users.")
        print("Fill their 'password' column in db/credentials-input.csv and re-run:\n")
        for n, e in missing:
            print(f"   - {n:20} {e}")
        print(f"\n({len(missing)} existing users unfilled.) No passwords were invented; no PDF written.")
        sys.exit(2)
    build_pdf(rows)
    print(f"OK — wrote {PDF_OUT}\n")
    print(f"{'STATUS':9} {'ROLE':12} {'EMAIL':30} PASSWORD")
    for r in rows:
        print(f"{r['status'].upper():9} {r['role']:12} {r['email']:30} {r['password']}")

if __name__ == "__main__":
    main()
