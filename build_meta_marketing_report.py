"""
build_meta_marketing_report.py

Builds Meta_Marketing_Report.xlsx from Meta_Leads_Data.json
(produced by export_meta_marketing_data.js).

Layout (all report numbers are formulas over the Data tab, so the future daily
Google Sheet job only has to rewrite Data and extend the trend tabs):
  Report      - the 4-section funnel format, driven by a View (Daily / Weekly /
                Monthly / Custom / All time) + Date selector
  Daily       - one row per day
  Weekly      - one row per Mon-Sun week
  Monthly     - one row per month
  Data        - one row per Meta lead
  Definitions - which Firestore field drives each metric

Usage:
  python build_meta_marketing_report.py [data.json] [output.xlsx]
"""

import json
import os
import sys
from datetime import date, timedelta

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "Meta_Leads_Data.json")
OUT_PATH = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "Meta_Marketing_Report.xlsx")

NAVY = PatternFill("solid", fgColor="14213D")
GREY = PatternFill("solid", fgColor="E8ECF2")
INPUT = PatternFill("solid", fgColor="FFF4CC")
WHITE_B = Font(bold=True, color="FFFFFF")
BOLD = Font(bold=True)
TITLE = Font(bold=True, size=14)
SECTION = Font(bold=True, size=12, color="1F5C99")
NOTE = Font(italic=True, color="666666", size=9)
THIN = Side(style="thin", color="C9CED6")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
PCT = "0.0%"
INR = "#,##0;-#,##0;\"-\""
NUM = "#,##0"

with open(DATA_PATH, encoding="utf-8") as f:
    payload = json.load(f)
rows = payload["rows"]
start = date.fromisoformat(payload["start"])
today = date.today()

wb = Workbook()

# ------------------------------------------------------------------ Data tab
ws_data = wb.active
ws_data.title = "Data"
headers = list(rows[0].keys()) if rows else []
ws_data.append(headers)
for r in rows:
    vals = []
    for h in headers:
        v = r[h]
        if h in ("Lead Date", "Pre-Active Date", "Active Date") and v:
            v = date.fromisoformat(v)
        vals.append(v)
    ws_data.append(vals)
for i, h in enumerate(headers, 1):
    c = ws_data.cell(row=1, column=i)
    c.fill, c.font = NAVY, WHITE_B
    ws_data.column_dimensions[get_column_letter(i)].width = max(12, len(h) + 2)
    if h in ("Lead Date", "Pre-Active Date", "Active Date"):
        for row in ws_data.iter_rows(min_row=2, min_col=i, max_col=i):
            row[0].number_format = "yyyy-mm-dd"
ws_data.freeze_panes = "A2"
ws_data.auto_filter.ref = ws_data.dimensions

COL = {h: get_column_letter(i) for i, h in enumerate(headers, 1)}


def rng(h):
    return f"Data!${COL[h]}:${COL[h]}"


def base(frm, to):
    """COUNTIFS/SUMIFS criteria pairs: lead date within [frm, to], not a test lead."""
    return f'{rng("Lead Date")},">="&{frm},{rng("Lead Date")},"<="&{to},{rng("Is Test")},0'


def cnt(frm, to, *extra):
    crit = "".join(f",{rng(h)},{v}" for h, v in extra)
    return f"COUNTIFS({base(frm, to)}{crit})"


def sm(field, frm, to, *extra):
    crit = "".join(f",{rng(h)},{v}" for h, v in extra)
    return f"SUMIFS({rng(field)},{base(frm, to)}{crit})"


CONNECTED = ("Connected By", '"<>Not connected"')
INT = ("Interest", '"interested"')
SUPER = ("Interest", '"super interested"')
NOTINT = ("Interest", '"not interested"')


def style_header(ws, r, c1, c2):
    for c in range(c1, c2 + 1):
        cell = ws.cell(row=r, column=c)
        cell.fill, cell.font, cell.border = NAVY, WHITE_B, BOX
        cell.alignment = Alignment(wrap_text=True, vertical="center")


def box(ws, r, c1, c2, bold=False, fill=None):
    for c in range(c1, c2 + 1):
        cell = ws.cell(row=r, column=c)
        cell.border = BOX
        if bold:
            cell.font = BOLD
        if fill:
            cell.fill = fill


# ------------------------------------------------------------------ Report tab
ws = wb.create_sheet("Report", 0)
ws["A1"] = "Meta leads funnel"
ws["A1"].font = TITLE
ws["A3"], ws["B3"] = "View", "Weekly"
ws["A4"], ws["B4"] = "Date (any day in period)", "=TODAY()"
ws["A5"], ws["B5"] = "Custom: to date", "=TODAY()"
ws["A6"] = "Period from"
ws["B6"] = '=IF(B3="Daily",B4,IF(B3="Weekly",B4-WEEKDAY(B4,3),IF(B3="Monthly",DATE(YEAR(B4),MONTH(B4),1),IF(B3="Custom",B4,DATE(2000,1,1)))))'
ws["A7"] = "Period to"
ws["B7"] = '=IF(B3="Daily",B4,IF(B3="Weekly",B6+6,IF(B3="Monthly",EOMONTH(B4,0),IF(B3="Custom",B5,DATE(2100,12,31)))))'
for a in ("A3", "A4", "A5", "A6", "A7"):
    ws[a].font = BOLD
for b in ("B3", "B4", "B5"):
    ws[b].fill = INPUT
    ws[b].border = BOX
for b in ("B4", "B5", "B6", "B7"):
    ws[b].number_format = "dd-mmm-yyyy"
ws["C3"] = "Daily / Weekly / Monthly / Custom / All time"
ws["C4"] = "Weekly = Mon-Sun week containing this date. Custom uses B4 as from-date."
ws["C3"].font = ws["C4"].font = NOTE
dv = DataValidation(type="list", formula1='"Daily,Weekly,Monthly,Custom,All time"', allow_blank=False)
ws.add_data_validation(dv)
dv.add("B3")

F, T = "$B$6", "$B$7"

# 1. Funnel
r = 9
ws.cell(row=r, column=1, value="1. Funnel").font = SECTION
r += 1
for i, h in enumerate(["Stage", "Leads", "% of total leads", "% of previous stage"], 1):
    ws.cell(row=r, column=i, value=h)
style_header(ws, r, 1, 4)
funnel = [
    ("Total leads", cnt(F, T)),
    ("Connected", cnt(F, T, CONNECTED)),
    ("Still interested", f"{cnt(F, T, CONNECTED, INT)}+{cnt(F, T, CONNECTED, SUPER)}"),
    ("Super interested", cnt(F, T, SUPER)),
    ("Qualified", cnt(F, T, ("Qualified", 1))),
    ("Proforma raised", cnt(F, T, ("Proforma Raised", 1))),
    ("Paid", cnt(F, T, ("Paid", 1))),
]
first = r + 1
for i, (label, formula) in enumerate(funnel):
    rr = first + i
    ws.cell(row=rr, column=1, value=label).font = BOLD
    ws.cell(row=rr, column=2, value=f"={formula}").number_format = NUM
    ws.cell(row=rr, column=3, value=f"=IFERROR(B{rr}/$B${first},0)").number_format = PCT
    if label == "Qualified":
        # Qualified is independent of the interest marking, so compare it to total leads
        ws.cell(row=rr, column=4, value=f"=IFERROR(B{rr}/$B${first},0)").number_format = PCT
        ws.cell(row=rr, column=5, value="vs total leads (independent of interest)").font = NOTE
    elif i:
        ws.cell(row=rr, column=4, value=f"=IFERROR(B{rr}/B{rr - 1},0)").number_format = PCT
    box(ws, rr, 1, 4)
r = first + len(funnel) + 1

# 2. Interest marking
ws.cell(row=r, column=1, value="2. Interest marking").font = SECTION
r += 1
ws.cell(row=r, column=1, value="Marking")
ws.cell(row=r, column=2, value="Leads")
style_header(ws, r, 1, 2)
im_first = r + 1
for i, (label, crit) in enumerate([("Interested", INT), ("Super interested", SUPER), ("Not interested", NOTINT)]):
    rr = im_first + i
    ws.cell(row=rr, column=1, value=label).font = BOLD
    ws.cell(row=rr, column=2, value=f"={cnt(F, T, crit)}").number_format = NUM
    box(ws, rr, 1, 2)
rr = im_first + 3
ws.cell(row=rr, column=1, value="Other (on hold / blank)").font = BOLD
ws.cell(row=rr, column=2, value=f"=B{first}-SUM(B{im_first}:B{rr - 1})").number_format = NUM
box(ws, rr, 1, 2)
rr += 1
ws.cell(row=rr, column=1, value="Total")
ws.cell(row=rr, column=2, value=f"=SUM(B{im_first}:B{rr - 1})").number_format = NUM
box(ws, rr, 1, 2, bold=True, fill=GREY)
r = rr + 2

# 3. Leads by who connected
ws.cell(row=r, column=1, value="3. Leads by who connected").font = SECTION
r += 1
cols3 = ["Connected by", "Leads", "Super interested", "Interested", "Not interested", "Qualified", "Proforma raised", "Moved to Active"]
for i, h in enumerate(cols3, 1):
    ws.cell(row=r, column=i, value=h)
style_header(ws, r, 1, len(cols3))
c3_first = r + 1
for i, who in enumerate(["Sales team", "WhatsApp bot", "Not connected"]):
    rr = c3_first + i
    by = ("Connected By", f'"{who}"')
    ws.cell(row=rr, column=1, value=who).font = BOLD
    for j, f in enumerate(
        [
            cnt(F, T, by),
            cnt(F, T, by, SUPER),
            cnt(F, T, by, INT),
            cnt(F, T, by, NOTINT),
            cnt(F, T, by, ("Qualified", 1)),
            cnt(F, T, by, ("Proforma Raised", 1)),
            cnt(F, T, by, ("Moved to Active", 1)),
        ],
        2,
    ):
        ws.cell(row=rr, column=j, value=f"={f}").number_format = NUM
    box(ws, rr, 1, len(cols3))
rr = c3_first + 3
ws.cell(row=rr, column=1, value="Total")
for j in range(2, len(cols3) + 1):
    L = get_column_letter(j)
    ws.cell(row=rr, column=j, value=f"=SUM({L}{c3_first}:{L}{rr - 1})").number_format = NUM
box(ws, rr, 1, len(cols3), bold=True, fill=GREY)
ws.cell(row=rr + 1, column=1, value="Not connected leads are the untouched default 'interested' marks.").font = NOTE
r = rr + 3

# 4. Money
ws.cell(row=r, column=1, value="4. Money (Rs)").font = SECTION
r += 1
m_first = r
money = [
    ("Proformas raised", f"={sm('Proformas', F, T)}", NUM),
    ("Total invoiced", f"={sm('Invoiced Amount', F, T)}", INR),
    ("Total paid", f"={sm('Paid Amount', F, T)}", INR),
    ("Balance due", f"=B{m_first + 1}-B{m_first + 2}", INR),
]
for i, (label, f, fmt) in enumerate(money):
    rr = m_first + i
    ws.cell(row=rr, column=1, value=label).font = BOLD
    ws.cell(row=rr, column=2, value=f).number_format = fmt
    box(ws, rr, 1, 2)
r = m_first + len(money) + 1

# 5. Conversion: pre active -> active
ws.cell(row=r, column=1, value="5. Conversion (pre active -> active)").font = SECTION
r += 1
for i, h in enumerate(["Metric", "Leads", "%"], 1):
    ws.cell(row=r, column=i, value=h)
style_header(ws, r, 1, 3)
v_first = r + 1
conv = [
    ("Leads (pre active)", f"={cnt(F, T)}", None),
    ("Qualified", f"={cnt(F, T, ('Qualified', 1))}", f"=IFERROR(B{v_first + 1}/B{v_first},0)"),
    ("Moved to Active", f"={cnt(F, T, ('Moved to Active', 1))}", f"=IFERROR(B{v_first + 2}/B{v_first},0)"),
    ("Active as % of qualified", f"=B{v_first + 2}", f"=IFERROR(B{v_first + 2}/B{v_first + 1},0)"),
    ("Still pre active", f"=B{v_first}-B{v_first + 2}", f"=IFERROR(B{v_first + 4}/B{v_first},0)"),
]
for i, (label, f, pf) in enumerate(conv):
    rr = v_first + i
    ws.cell(row=rr, column=1, value=label).font = BOLD
    ws.cell(row=rr, column=2, value=f).number_format = NUM
    if pf:
        ws.cell(row=rr, column=3, value=pf).number_format = PCT
    box(ws, rr, 1, 3)
ws.cell(row=v_first + len(conv), column=1, value="Conversion % = Moved to Active / Leads (pre active).").font = NOTE

ws.column_dimensions["A"].width = 26
for L in "BCDEFG":
    ws.column_dimensions[L].width = 16
ws.column_dimensions["C"].width = 18
ws.freeze_panes = "A9"

# ------------------------------------------------------------------ Trend tabs
TREND_COLS = [
    ("Total leads", lambda f, t: cnt(f, t), NUM),
    ("Connected", lambda f, t: cnt(f, t, CONNECTED), NUM),
    ("Connected %", None, PCT),
    ("Sales team", lambda f, t: cnt(f, t, ("Connected By", '"Sales team"')), NUM),
    ("WhatsApp bot", lambda f, t: cnt(f, t, ("Connected By", '"WhatsApp bot"')), NUM),
    ("Not connected", lambda f, t: cnt(f, t, ("Connected By", '"Not connected"')), NUM),
    ("Still interested", lambda f, t: f"{cnt(f, t, CONNECTED, INT)}+{cnt(f, t, CONNECTED, SUPER)}", NUM),
    ("Interested", lambda f, t: cnt(f, t, INT), NUM),
    ("Super interested", lambda f, t: cnt(f, t, SUPER), NUM),
    ("Not interested", lambda f, t: cnt(f, t, NOTINT), NUM),
    ("Qualified", lambda f, t: cnt(f, t, ("Qualified", 1)), NUM),
    ("Proforma raised", lambda f, t: cnt(f, t, ("Proforma Raised", 1)), NUM),
    ("Paid", lambda f, t: cnt(f, t, ("Paid", 1)), NUM),
    ("Lead -> Qualified %", None, PCT),
    ("Moved to Active", lambda f, t: cnt(f, t, ("Moved to Active", 1)), NUM),
    ("Conversion % (pre active -> active)", None, PCT),
    ("Proformas", lambda f, t: sm("Proformas", f, t), NUM),
    ("Invoiced (Rs)", lambda f, t: sm("Invoiced Amount", f, t), INR),
    ("Paid (Rs)", lambda f, t: sm("Paid Amount", f, t), INR),
    ("Balance due (Rs)", None, INR),
]


def periods(kind):
    out = []
    if kind == "Daily":
        d = start
        while d <= today:
            out.append((d, d))
            d += timedelta(days=1)
    elif kind == "Weekly":
        d = start - timedelta(days=start.weekday())
        while d <= today:
            out.append((d, d + timedelta(days=6)))
            d += timedelta(days=7)
    else:
        d = date(start.year, start.month, 1)
        while d <= today:
            nxt = date(d.year + (d.month == 12), d.month % 12 + 1, 1)
            out.append((d, nxt - timedelta(days=1)))
            d = nxt
    return list(reversed(out))  # newest first


for kind in ("Daily", "Weekly", "Monthly"):
    wt = wb.create_sheet(kind, list(wb.sheetnames).index("Data"))
    hdr = ["From", "To"] + [c[0] for c in TREND_COLS]
    wt.append(hdr)
    style_header(wt, 1, 1, len(hdr))
    letter = {name: get_column_letter(i + 3) for i, (name, _, _) in enumerate(TREND_COLS)}
    for i, (pf, pt) in enumerate(periods(kind)):
        rr = i + 2
        wt.cell(row=rr, column=1, value=pf).number_format = "dd-mmm-yy"
        wt.cell(row=rr, column=2, value=pt).number_format = "dd-mmm-yy"
        f, t = f"$A{rr}", f"$B{rr}"
        for j, (name, fn, fmt) in enumerate(TREND_COLS, 3):
            if name == "Connected %":
                formula = f"=IFERROR({letter['Connected']}{rr}/{letter['Total leads']}{rr},0)"
            elif name == "Lead -> Qualified %":
                formula = f"=IFERROR({letter['Qualified']}{rr}/{letter['Total leads']}{rr},0)"
            elif name == "Conversion % (pre active -> active)":
                formula = f"=IFERROR({letter['Moved to Active']}{rr}/{letter['Total leads']}{rr},0)"
            elif name == "Balance due (Rs)":
                formula = f"={letter['Invoiced (Rs)']}{rr}-{letter['Paid (Rs)']}{rr}"
            else:
                formula = f"={fn(f, t)}"
            wt.cell(row=rr, column=j, value=formula).number_format = fmt
        box(wt, rr, 1, len(hdr))
    for j in range(1, len(hdr) + 1):
        wt.column_dimensions[get_column_letter(j)].width = 12
    wt.row_dimensions[1].height = 32
    wt.freeze_panes = "C2"

# ------------------------------------------------------------------ Definitions
wd = wb.create_sheet("Definitions")
wd.append(["Metric", "Firestore source / rule"])
style_header(wd, 1, 1, 2)
defs = [
    ("Lead (Total leads)", "vaultServices with serviceSource = Meta / facebook / instagram (any case) that are, or have been, in bucket 'pre active' (current bucket or bucketTransitions). Only services whose owning vaultUsers.acquisitionPOC = 'Manas Pandit'. One row per service. Lead date = vaultServices.added (IST)."),
    ("Test leads", "Excluded everywhere: owning user's userName contains 'test' (Is Test = 1 on Data tab)."),
    ("Interest marking", "Owning vaultUsers.userInterest (interested / super interested / not interested; 'on hold' or blank falls in Other)."),
    ("Connected by: Sales team", "Owning vaultUsers.connectedAttempts > 0 OR callStatus = 'connected' (CRM status). Takes priority over the bot."),
    ("Connected by: WhatsApp bot", "vaultUsers.whatsappConversationInitiated = true and no sales connect."),
    ("Connected by: Not connected", "Neither of the above."),
    ("Still interested", "Connected (sales or bot) AND userInterest is interested or super interested."),
    ("Qualified", "This service's serviceStage = 'qualified' (vs 'unqualified'), or the service has already moved to bucket active. Independent of the interest marking."),
    ("Moved to Active (conversion)", "This service's bucketTransitions has 'active' after 'pre active', or its current bucket is active."),
    ("Proforma raised", "This service appears in a vaultProforma's proformaServices (draft and lost proformas, deleted lines excluded)."),
    ("Paid", "amountPaid on this service's proforma line(s) > 0."),
    ("Proformas raised (money)", "Count of distinct proformas containing the lead's service."),
    ("Total invoiced", "Sum of serviceAmount on the service's proforma line(s)."),
    ("Total paid", "Sum of amountPaid on the service's proforma line(s)."),
    ("Balance due", "Total invoiced - Total paid."),
    ("Period logic", "A period shows leads that CAME IN (service added) in that period, with their status as of the last data refresh."),
    ("Data refreshed", payload.get("generatedAt", "")),
]
for d in defs:
    wd.append(list(d))
wd.column_dimensions["A"].width = 30
wd.column_dimensions["B"].width = 120
for row in wd.iter_rows(min_row=2):
    for c in row:
        c.alignment = Alignment(wrap_text=True, vertical="top")
        c.border = BOX

wb.active = 0
wb.save(OUT_PATH)
print(f"Wrote {OUT_PATH} ({len(rows)} lead rows)")
