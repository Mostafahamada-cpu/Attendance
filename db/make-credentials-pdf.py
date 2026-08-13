#!/usr/bin/env python3
"""
RingRoad Attendance — credentials PDF generator.

Reads db/credentials-input.csv and produces a professional PDF:
    Name | Department/Role | Email | Password

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
                    "first sign-in (More → Change Password).", body), Spacer(1, 4)]

    data = [[Paragraph("#",hdr),Paragraph("Name",hdr),Paragraph("Department / Role",hdr),
             Paragraph("Email",hdr),Paragraph("Password",hdr)]]
    admin_idx = []
    for i, r in enumerate(rows, 1):
        is_admin = r["role"].strip().lower() in ("admin", "management")
        if is_admin: admin_idx.append(i)
        role = r["role"] + ("  •  ADMIN" if is_admin else "")
        data.append([Paragraph(str(i),cell), Paragraph(r["name"],cellb),
                     Paragraph(role,cell), Paragraph(r["email"],cell), Paragraph(r["password"], mono)])
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
                        "Existing RingRoad logins keep their current password (unchanged); new Engineers use the "
                        "temporary password shown. Keep this document confidential.", note))
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
