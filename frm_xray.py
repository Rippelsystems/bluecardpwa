"""
frm_xray.py — X-RAY REPORTS   (QUALITY → X-Ray Reports)          23/11/2026

Gammex radiograph every casting on a tree and send back FORM EL060 as a PDF
(e.g. RT419739: REAR CROSS, order POA25214, 102 trees, 408 result lines).
Each casting is shot from FOUR ANGLES — A, B, C, D. A casting that fails even
ONE angle is scrapped and goes back to Vestcast to be melted and recast.

QC engrave the serials BEFORE the castings go to X-ray, running on from the
list on the dot matrix engraver. When the report comes back the serial is typed
against each tree — that is how a rejected casting is identified by serial.
Those are the same numbers that end up on the Blue Card (RLL = low velocity,
LRC / LFM; XRGL40 = high velocity, HRC / HFM), so THE NUMBER ONLY is stored
here and the prefix is left to the Blue Card, which already compares numbers
with the prefix stripped.

WHAT THIS SCREEN DOES
  Import   read a Gammex PDF exactly as it stands, pick the country and the
           contract (Gammex cannot know those), and save it. The import
           REFUSES unless the report came out whole — every tree with four
           angles, and lines = trees x 4 — so a short read can never pass
           unnoticed.
  Serials  type the engraved number against each tree. Enter moves down.
  Search   by Item, by Order No (POA) or by Report No.
  Print    Excel (a flat sheet to work with) and PDF (the recognised layout,
           internal use), with every scrapped casting in red.

Tables: xray_reports, xray_trees, xray_results  (xray_reports_23Nov.sql).
Nothing in this file writes to weapon_builds or to any Blue Card table.

Needs pdfplumber, openpyxl and reportlab — all three already ship with the
Matrix release.
"""
import os
import re
import threading
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
from datetime import datetime

import db_manager

FILE_LABEL = "frm_xray.py"

# ─────────────────────────────────────────────────────────────────────────────
# THE GAMMEX PDF READER
#
# Two things about this layout will silently corrupt a naive import:
#
#  1. The DESCRIPTION cell ("TREE 5-126 - 1") is MERGED across the four angle
#     rows of that casting. Read as plain text the label lands between rows B
#     and C, so every block ends up against the wrong tree. Read as a TABLE it
#     sits on the row carrying angle A — which is what this reader relies on.
#
#  2. A header line carries two or three fields side by side:
#        ITEM: REAR CROSS   PART NO: TREE   SUPPLIER: RIPPEL EFFECT SYSTEMS
#     and some values hold colons of their own ("ASTM E192: 9.5: 19 mm"), so a
#     value is cut at the next KNOWN label — never at the next colon and never
#     at the next capitalised word.
# ─────────────────────────────────────────────────────────────────────────────

# every label on page 1 of FORM EL060
_LABELS = [
    'REPORT NO', 'PAGE', 'CLIENT', 'DATE', 'ORDER NO', 'JOB NO',
    'ITEM', 'PART NO', 'SUPPLIER', 'MATERIAL', 'DRAWING NO', 'ACC. STD',
    'PROCEDURE NO', 'DESIGN CODE', 'TEST SPEC', 'WELD PROCESS',
    'CAST BATCH NO', 'AREA TESTED',
    'SINGLE WALL SINGLE IMAGE', 'DOUBLE WALL SINGLE IMAGE',
    'DOUBLE WALL DOUBLE IMAGE', 'SOURCE', 'SOD/SFD', 'ACTIVITY', 'I.Q.I',
    'EXPOSURE TIME', 'THICKNESS', 'FILM TYPE', 'FILM SIZE',
    'BATCH NO/EXP DATE', 'SCREENS', 'SENSITIVITY', 'FILM PROCESSING',
    'NUMBER OF FILM IN EACH HOLDER/CASETTE',
    'SINGLE WALL VIEWING', 'DOUBLE WALL VIEWING',
    'SURFACE CONDITION', 'TEST LOCATION', 'NAME', 'QUALIFICATION',
]
_NEXT_LABEL = re.compile(
    r'\s+(?=(?:' + '|'.join(re.escape(x) for x in
                            sorted(_LABELS, key=len, reverse=True)) + r')\s*:)')

_TREE = re.compile(r'TREE\s*([0-9A-Z]+)\s*-\s*([0-9A-Z]+)\s*[-–—]\s*([0-9]+)', re.I)
_DENS = re.compile(r'^[0-9]\.[0-9]\s*[-–—]\s*[0-9]\.[0-9]$')
_IQI = re.compile(r'^[0-9]+\s*(?:TH|ST|ND|RD)$', re.I)
_POSITIONS = ('A', 'B', 'C', 'D')
_RESULTS = ('PASS', 'REJECTED', 'FAIL')

# the header fields kept; the rest of page 1 stays in the Gammex PDF itself
_KEEP = ('REPORT NO', 'CLIENT', 'DATE', 'ORDER NO', 'JOB NO', 'ITEM', 'PART NO',
         'SUPPLIER', 'MATERIAL', 'DRAWING NO', 'PROCEDURE NO', 'DESIGN CODE',
         'ACC. STD', 'TEST SPEC', 'CAST BATCH NO', 'AREA TESTED',
         'SURFACE CONDITION', 'TEST LOCATION', 'NAME', 'QUALIFICATION')

# header label -> xray_reports column
_COLUMN = {
    'REPORT NO': 'report_no', 'CLIENT': 'client', 'ORDER NO': 'order_no',
    'JOB NO': 'job_no', 'ITEM': 'item', 'PART NO': 'part_no',
    'SUPPLIER': 'supplier', 'MATERIAL': 'material', 'DRAWING NO': 'drawing_no',
    'PROCEDURE NO': 'procedure_no', 'DESIGN CODE': 'design_code',
    'ACC. STD': 'acc_std', 'TEST SPEC': 'test_spec',
    'CAST BATCH NO': 'cast_batch_no', 'AREA TESTED': 'area_tested',
    'SURFACE CONDITION': 'surface_condition', 'TEST LOCATION': 'test_location',
    'NAME': 'technician_name', 'QUALIFICATION': 'technician_qual',
}


def _header_value(text, label):
    """The value of `label`, cut at the next known label on the same line."""
    m = re.search(r'(?:^|\s)' + re.escape(label) + r'\s*:\s*(.*)', text)
    if not m:
        return ''
    return _NEXT_LABEL.split(m.group(1).strip(), 1)[0].strip()


def read_gammex_pdf(path):
    """Read a Gammex EL060 PDF -> (header dict, trees list, lines list).

    Nothing is invented and nothing is corrected: whatever Gammex wrote is
    what comes back. Raises if the file will not open as a PDF.
    """
    import pdfplumber
    header, trees, lines = {}, [], []
    with pdfplumber.open(path) as pdf:
        page1 = pdf.pages[0].extract_text() or ''
        for label in _KEEP:
            value = _header_value(page1, label)
            if value:
                header[label] = value
        header['PAGES'] = len(pdf.pages)

        current = None
        for page_no, page in enumerate(pdf.pages, start=1):
            for table in page.extract_tables():
                for row in table:
                    cells = [(c or '').replace('\n', ' ').strip() for c in row]
                    position = next((c for c in cells if c in _POSITIONS), None)
                    result = next((c for c in cells if c.upper() in _RESULTS), None)
                    if position is None or result is None:
                        continue                       # not a result row
                    found = _TREE.search(' '.join(cells))
                    if found:                          # angle A carries the label
                        current = 'TREE %s-%s-%s' % tuple(
                            x.upper() for x in found.groups())
                        trees.append({'tree': current, 'page': page_no})
                    i = cells.index(position)
                    lines.append({
                        'tree': current,
                        'page': page_no,
                        'density': next((c for c in cells if _DENS.match(c)), ''),
                        'iqi': next((c for c in cells if _IQI.match(c)), ''),
                        'position': position,
                        # whatever sits between the angle and the result
                        'interpretation': next(
                            (c for c in cells[i + 1:]
                             if c and c.upper() not in _RESULTS), ''),
                        'result': result.upper(),
                    })
    return header, trees, lines


def verify_report(header, trees, lines):
    """-> list of problems in plain words. Empty list = the report came out whole.

    The import refuses to save while this returns anything.
    """
    bad = []
    if not header.get('REPORT NO'):
        bad.append('The report number could not be read off page 1.')
    if not header.get('ITEM'):
        bad.append('The ITEM could not be read off page 1.')
    if not trees:
        bad.append('No TREE blocks were found — this may not be a Gammex '
                   'EL060 radiographic report.')
        return bad

    seen = {}
    for t in trees:
        seen[t['tree']] = seen.get(t['tree'], 0) + 1
    dupes = sorted(k for k, v in seen.items() if v > 1)
    if dupes:
        bad.append('The same tree appears more than once: '
                   + _some(dupes))

    orphans = sum(1 for x in lines if not x['tree'])
    if orphans:
        bad.append('%d result line(s) come before any tree — they would be '
                   'saved against the wrong casting.' % orphans)

    counts = {}
    for x in lines:
        counts[x['tree']] = counts.get(x['tree'], 0) + 1
    wrong = sorted(t['tree'] for t in trees if counts.get(t['tree']) != 4)
    if wrong:
        bad.append('%d tree(s) do not have all four angles: %s'
                   % (len(wrong), _some(wrong)))

    for t in trees:
        got = sorted(x['position'] for x in lines if x['tree'] == t['tree'])
        if got and got != ['A', 'B', 'C', 'D']:
            bad.append('%s has angles %s instead of A, B, C, D.'
                       % (t['tree'], ', '.join(got)))
            break

    if len(lines) != len(trees) * 4:
        bad.append('%d trees should give %d result lines, but %d were read.'
                   % (len(trees), len(trees) * 4, len(lines)))
    return bad


def _some(names, n=10):
    if len(names) <= n:
        return ', '.join(names)
    return '%s (and %d more)' % (', '.join(names[:n]), len(names) - n)


def scrapped_trees(lines):
    """The trees with at least one angle that is not PASS — the scrapped castings."""
    return {x['tree'] for x in lines if x['result'] != 'PASS'}


def import_summary(header, trees, lines):
    scrap = scrapped_trees(lines)
    return ('%s  ·  %s  ·  order %s  ·  %d pages\n'
            '%d castings (trees)  ·  %d result lines  ·  %d angle(s) not PASS\n'
            '%d casting(s) SCRAPPED%s'
            % (header.get('REPORT NO', '?'), header.get('ITEM', '?'),
               header.get('ORDER NO', '?'), header.get('PAGES', 0),
               len(trees), len(lines),
               sum(1 for x in lines if x['result'] != 'PASS'),
               len(scrap),
               (': ' + _some(sorted(scrap), 6)) if scrap else ''))


def gammex_date(text):
    """Gammex write 22/09/2026. -> 'YYYY-MM-DD' or None (never a guess)."""
    m = re.match(r'\s*([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})\s*$', text or '')
    if not m:
        return None
    d, mth, y = m.groups()
    try:
        return datetime(int(y), int(mth), int(d)).strftime('%Y-%m-%d')
    except ValueError:
        return None


def report_row(header, trees, lines, country, contract, source_file, user):
    """The xray_reports row to insert, built from what was read."""
    row = {}
    for label, column in _COLUMN.items():
        if header.get(label):
            row[column] = header[label]
    row['report_date'] = gammex_date(header.get('DATE', ''))
    row['pages'] = header.get('PAGES')
    row['client_country'] = country or None
    row['contract_name'] = contract or None
    row['trees_count'] = len(trees)
    row['lines_count'] = len(lines)
    row['rejected_lines'] = sum(1 for x in lines if x['result'] != 'PASS')
    row['scrapped_trees'] = len(scrapped_trees(lines))
    row['source_file'] = source_file or None
    row['imported_by'] = user or None
    return row


def tree_rows(report_id, header, trees, lines):
    """The xray_trees rows — one per casting, result PASS or REJECTED."""
    scrap = scrapped_trees(lines)
    out = []
    for i, t in enumerate(trees, start=1):
        out.append({
            'report_id': report_id,
            'tree_no': t['tree'],
            'page': t['page'],
            'line_no': i,
            'item': header.get('ITEM'),
            'serial': None,
            'result': 'REJECTED' if t['tree'] in scrap else 'PASS',
        })
    return out


def result_rows(report_id, tree_ids, lines):
    """The xray_results rows — four per casting, exactly as Gammex wrote them.

    tree_ids: {tree_no: id}. A line whose tree has no id is left out and the
    caller is told, rather than being saved against nothing.
    """
    out, lost = [], []
    for x in lines:
        tid = tree_ids.get(x['tree'])
        if not tid:
            lost.append(x['tree'])
            continue
        out.append({
            'report_id': report_id,
            'tree_id': tid,
            'tree_no': x['tree'],
            'page': x['page'],
            'density': x['density'] or None,
            'iqi': x['iqi'] or None,
            'position': x['position'],
            'interpretation': x['interpretation'] or None,
            'result': x['result'],
        })
    return out, lost


# ─────────────────────────────────────────────────────────────────────────────
# WHAT GOES INTO THE EXPORTS  (pure — no Tkinter, no database)
# ─────────────────────────────────────────────────────────────────────────────

EXPORT_COLUMNS = ('Report No', 'Report Date', 'Item', 'Order No', 'Job No',
                  'Country', 'Contract', 'Tree', 'Serial', 'Casting Result',
                  'Density', 'IQI Wire/No', 'Angle', 'Interpretation',
                  'Result of Test')


def export_rows(report, trees, results):
    """One row per result line, with its casting's serial beside it.

    report: the xray_reports row. trees: xray_trees rows. results: xray_results
    rows. Ordered the way the Gammex report reads: tree in report order, then
    angle A to D.
    """
    by_tree = {t['tree_no']: t for t in trees}
    order = {t['tree_no']: (t.get('line_no') or 0) for t in trees}
    rows = []
    for r in sorted(results, key=lambda x: (order.get(x['tree_no'], 0),
                                            x.get('position') or '')):
        t = by_tree.get(r['tree_no'], {})
        rows.append([
            report.get('report_no', ''), report.get('report_date', '') or '',
            report.get('item', '') or '', report.get('order_no', '') or '',
            report.get('job_no', '') or '', report.get('client_country', '') or '',
            report.get('contract_name', '') or '',
            r.get('tree_no', ''), t.get('serial') or '',
            t.get('result', '') or '',
            r.get('density') or '', r.get('iqi') or '',
            r.get('position') or '', r.get('interpretation') or '',
            r.get('result') or '',
        ])
    return rows


def is_scrapped_row(row):
    """A row belonging to a scrapped casting — the whole block goes red.

    Gerhard 23/11/2026: colour the WHOLE tree, not just the failed angle,
    because one failed angle condemns the casting.
    """
    return (row[9] or '').upper() == 'REJECTED'




# ─── THE ENGRAVED PREFIX  (pure — no Tkinter, no database) ───────────────────
# Gerhard 23/11/2026: the first number in the tree says which casting it is —
# TREE 4-... is a HOUSING FRONT MAIN, TREE 5-... is a REAR CROSS. Both are
# XRGL40 parts, which are the HIGH velocity ones, so they are engraved HFM-
# and HRC- (the RLL low-velocity equivalents are LFM- and LRC-).
#
# The prefix is shown in front of the serial box so the operator types only the
# number. WHAT IS STORED IS STILL THE NUMBER ALONE, as Gerhard confirmed on
# 23/11 — the Blue Card compares component numbers with the leading prefix
# stripped (bluecard_component_norm), so the two sides still match.
ITEM_PREFIX = {"HOUSING FRONT MAIN": "HFM-", "REAR CROSS": "HRC-"}
TREE_PREFIX = {"4": "HFM-", "5": "HRC-"}
_TREE_LEAD = re.compile(r"\s*TREE\s*([0-9A-Z]+)", re.I)


def serial_prefix(item, tree_no):
    """The prefix to show in front of the serial box, or "" when it cannot be
    established.

    Never guessed. The ITEM off the Gammex report and the tree's leading number
    must agree; an item we do not know, a tree number we do not recognise, or
    the two disagreeing all give "" — the box is then simply typed in full,
    rather than the operator being shown a prefix that may be wrong.
    """
    by_item = ITEM_PREFIX.get((item or "").strip().upper(), "")
    m = _TREE_LEAD.match((tree_no or "").upper())
    by_tree = TREE_PREFIX.get(m.group(1), "") if m else ""
    if by_item and by_tree and by_item != by_tree:
        return ""                      # they disagree — say nothing
    return by_item or by_tree


def strip_serial_prefix(value, prefix):
    """Operators type the prefix out of habit. Take it off so it is never
    doubled: HFM-26301, hfm 26301, HFM26301 and HFM--26301 all give 26301.
    Anything that is not that prefix is left exactly as typed.
    """
    v = (value or "").strip()
    if not prefix or not v:
        return v
    letters = prefix.rstrip("-").upper()
    out = re.sub(r"^\s*" + re.escape(letters) + r"[\s\-_]*", "", v, flags=re.I)
    return out.strip()

# ─── THE FAULT COUNTS  (pure — no Tkinter, no database) ──────────────────────
FAULT_ANGLES = ("A", "B", "C", "D")


def faults_summary(data, item_filter="— All items —"):
    """Count the faults out of what Gammex recorded.

    data: {"reports": [...], "results": [...], "trees": [...]} straight off the
    three tables. item_filter: "— All items —" or one item.

    Nothing is estimated. A result line counts as a failure when Gammex marked
    it anything other than PASS, and a casting counts as scrapped when its own
    row says REJECTED — which is set at import from its four angles.
    """
    reports = data.get("reports") or []
    results = data.get("results") or []
    trees = data.get("trees") or []

    keep_all = (not item_filter) or item_filter.startswith("—")
    item_of = {r["id"]: (r.get("item") or "") for r in reports}
    want = lambda rid: keep_all or item_of.get(rid, "") == item_filter

    res = [x for x in results if want(x.get("report_id"))]
    trs = [x for x in trees if want(x.get("report_id"))]
    reps = [x for x in reports if want(x["id"])]

    # 1. per angle
    total_failed = sum(1 for x in res if (x.get("result") or "") != "PASS")
    angles = []
    for a in FAULT_ANGLES:
        shot = sum(1 for x in res if x.get("position") == a)
        bad = sum(1 for x in res
                  if x.get("position") == a and (x.get("result") or "") != "PASS")
        angles.append({
            "angle": a, "shot": shot, "failed": bad,
            "fail_pct": round(100.0 * bad / shot, 2) if shot else 0.0,
            "share_pct": round(100.0 * bad / total_failed, 1) if total_failed else 0.0,
        })
    angles.sort(key=lambda x: (-x["failed"], x["angle"]))

    # 2. what it failed on — the Gammex interpretation code
    what = {}
    for x in res:
        if (x.get("result") or "") == "PASS":
            continue
        key = (x.get("position") or "?", (x.get("interpretation") or "(blank)"))
        w = what.setdefault(key, {"times": 0, "items": set()})
        w["times"] += 1
        it = item_of.get(x.get("report_id"), "")
        if it:
            w["items"].add(it)
    what_rows = [(k[0], k[1], v["times"], ", ".join(sorted(v["items"])))
                 for k, v in what.items()]
    what_rows.sort(key=lambda r: (-r[2], r[0], r[1]))

    # 3. per report
    by_report = {}
    for x in res:
        if (x.get("result") or "") == "PASS":
            continue
        d = by_report.setdefault(x["report_id"], dict.fromkeys(FAULT_ANGLES, 0))
        if x.get("position") in d:
            d[x["position"]] += 1
    rep_rows = []
    for r in sorted(reps, key=lambda x: (str(x.get("report_date") or ""),
                                         str(x.get("report_no") or "")), reverse=True):
        d = by_report.get(r["id"], dict.fromkeys(FAULT_ANGLES, 0))
        n = int(r.get("trees_count") or 0)
        sc = int(r.get("scrapped_trees") or 0)
        rep_rows.append((r.get("report_no") or "", r.get("report_date") or "",
                         r.get("item") or "", n, sc,
                         ("%.1f%%" % (100.0 * sc / n)) if n else "—",
                         d["A"], d["B"], d["C"], d["D"]))

    # 4. position on the tree — "TREE 4-192-3" -> position 3
    pos = {}
    for t in trs:
        parts = str(t.get("tree_no") or "").split("-")
        if len(parts) < 3 or not parts[-1].strip():
            continue
        key = parts[-1].strip()
        p = pos.setdefault(key, {"castings": 0, "scrapped": 0, "items": set()})
        p["castings"] += 1
        if (t.get("result") or "") == "REJECTED":
            p["scrapped"] += 1
        if t.get("item"):
            p["items"].add(t["item"])
    pos_rows = [(k, v["castings"], v["scrapped"],
                 ("%.1f%%" % (100.0 * v["scrapped"] / v["castings"])) if v["castings"] else "—",
                 ", ".join(sorted(v["items"])))
                for k, v in pos.items()]
    pos_rows.sort(key=lambda r: (-(r[2] / r[1] if r[1] else 0), r[0]))

    return {"angles": angles, "what": what_rows,
            "reports": rep_rows, "positions": pos_rows}


# ─────────────────────────────────────────────────────────────────────────────
# THE SCREEN
# ─────────────────────────────────────────────────────────────────────────────
# ─── COLOURS ─────────────────────────────────────────────────────────────────
# Gerhard's rule (project instructions): no black writing on a blue background,
# and nothing dark on dark. Every pair below is set EXPLICITLY here rather than
# taken from THEME, because THEME["bg_panel"] is dark navy while THEME["text"]
# is dark — pairing the two is what made the import dialog unreadable on
# 23/11/2026. Dark backgrounds get light text; light backgrounds get dark text.
# t_contrast.py checks every pair in this file against a 4.5:1 ratio.
HEAD_BG = "#0d2137"      # window title bar — dark navy
HEAD_FG = "#4a9eff"      #   with light blue text
HEAD_SUB = "#8FB3DA"     #   and a lighter grey-blue for the side label

BAR_BG = "#E8F0FE"       # toolbars and panels — LIGHT blue
BAR_FG = "#1F3864"       #   with navy text
BAR_MUTED = "#4A5A75"    #   and a muted navy-grey

BODY_BG = "#FFFFFF"      # the page itself — white
BODY_FG = "#1A2333"      #   with near-black text
MUTED = "#5A6678"        #   and grey for secondary text

FIELD_BG = "#FFFFFF"     # entry boxes — white with dark text
FIELD_FG = "#1A2333"

RED_BG = "#FDECEA"       # a scrapped casting — LIGHT red
RED_FG = "#B71C1C"       #   with dark red text (same as the Excel and PDF)
OK_FG = "#1B5E20"        # a pass — dark green on light


class XRayReportsWindow(tk.Toplevel):
    """QUALITY → X-Ray Reports."""

    def __init__(self, parent):
        super().__init__(parent)
        self.title("X-Ray Reports — Gammex Radiographic Examination")
        self.configure(bg=BODY_BG)
        db_manager.fit_window(self)
        # Gerhard's rule: everything must show in full at 1366x740 on the
        # laptop, and fill the screen by itself when it is dragged onto a
        # bigger one. 1340x720 is the laptop size; zoomed is what the rest of
        # Matrix does (dashboard.py, frm_permissions.py) and is what makes it
        # follow a bigger screen. Both lists scroll, so nothing is ever cut off
        # at the small size either.
        self.geometry("1340x720")
        self.minsize(1100, 600)
        try:
            self.state("zoomed")
        except tk.TclError:
            pass                     # not every window manager has it

        self._reports = []          # every report row loaded
        self._report = None         # the one selected
        self._trees = []
        self._results = []
        self._serial_vars = {}      # tree_no -> StringVar
        self._serial_prefix = {}    # tree_no -> 'HFM-' / 'HRC-' / ''
        self._serial_entries = []   # in report order, for Enter-to-advance
        self._countries = []
        self._contracts = []
        self._busy = False

        self._build_ui()
        db_manager.show_dev_filename_label(self, FILE_LABEL)
        self.after(80, self._load_lists)
        self.after(120, self.reload_reports)

    # ── layout ──────────────────────────────────────────────────────────────
    def _build_ui(self):
        head = tk.Frame(self, bg=HEAD_BG, pady=10)
        head.pack(fill="x")
        tk.Label(head, text="X-RAY REPORTS — GAMMEX RADIOGRAPHIC EXAMINATION",
                 bg=HEAD_BG, fg=HEAD_FG, font=("Arial", 14, "bold")
                 ).pack(side="left", padx=16)
        # dropped 14px so it clears the grey filename label that
        # db_manager.show_dev_filename_label places at the top-right corner
        tk.Label(head, text="Rippel Effect Systems", bg=HEAD_BG, fg=HEAD_SUB,
                 font=("Arial", 9)).pack(side="right", padx=16, pady=(14, 0))

        bar = tk.Frame(self, bg=BAR_BG, pady=8)
        bar.pack(fill="x")
        self._button(bar, "📥  Import Gammex PDF", self.import_pdf,
                     "#1a6cf0").pack(side="left", padx=(16, 14))

        tk.Label(bar, text="Search", bg=BAR_BG, fg=MUTED,
                 font=("Arial", 9)).pack(side="left")
        self.search_var = tk.StringVar()
        ent = tk.Entry(bar, textvariable=self.search_var, width=26,
                       bg=FIELD_BG, fg=BODY_FG,
                       insertbackground=FIELD_FG, font=("Arial", 10),
                       relief="flat")
        ent.pack(side="left", padx=(6, 4), ipady=3)
        ent.bind("<Return>", lambda _e: self._apply_filter())
        self.search_var.trace_add("write", lambda *_a: self._apply_filter())
        tk.Label(bar, text="report no · order no (POA) · item",
                 bg=BAR_BG, fg=MUTED,
                 font=("Arial", 8)).pack(side="left", padx=(0, 16))

        tk.Label(bar, text="Item", bg=BAR_BG, fg=MUTED,
                 font=("Arial", 9)).pack(side="left")
        self.item_var = tk.StringVar(value="— All items —")
        self.item_pick = ttk.Combobox(bar, textvariable=self.item_var, width=24,
                                      state="readonly", font=("Arial", 10))
        self.item_pick.pack(side="left", padx=(6, 16))
        self.item_pick.bind("<<ComboboxSelected>>", lambda _e: self._apply_filter())

        self._button(bar, "↻  Refresh", self.reload_reports,
                     "#1a3a5c").pack(side="left")
        self.status = tk.Label(bar, text="", bg=BAR_BG,
                               fg=MUTED, font=("Arial", 9))
        self.status.pack(side="right", padx=16)

        tabs = ttk.Notebook(self)
        tabs.pack(fill="both", expand=True, padx=12, pady=(4, 10))
        self.tabs = tabs
        self.tab_reports = tk.Frame(tabs, bg=BODY_BG)
        self.tab_detail = tk.Frame(tabs, bg=BODY_BG)
        self.tab_faults = tk.Frame(tabs, bg=BODY_BG)
        tabs.add(self.tab_reports, text="  REPORTS  ")
        tabs.add(self.tab_detail, text="  CASTINGS & SERIALS  ")
        tabs.add(self.tab_faults, text="  FAULT REPORT  ")
        self._build_reports_tab()
        self._build_detail_tab()
        self._build_faults_tab()

    def _button(self, parent, text, command, bg, fg="#FFFFFF"):
        return tk.Button(parent, text=text, command=command, bg=bg, fg=fg,
                         font=("Arial", 9, "bold"), relief="flat", padx=14,
                         pady=4, cursor="hand2", activebackground="#1a6cf0",
                         activeforeground="#FFFFFF")

    def _build_reports_tab(self):
        f = self.tab_reports
        cols = ("report_no", "report_date", "item", "order_no", "job_no",
                "trees", "scrapped", "serials", "country", "contract")
        heads = ("Report No", "Date", "Item", "Order No (POA)", "Job No",
                 "Castings", "Scrapped", "Serials in", "Country", "Contract")
        widths = (110, 95, 160, 130, 90, 80, 80, 90, 130, 180)
        wrap = tk.Frame(f, bg=BODY_BG)
        wrap.pack(fill="both", expand=True, pady=(8, 0))
        self.tree_reports = ttk.Treeview(wrap, columns=cols, show="headings",
                                         selectmode="browse")
        for c, h, w in zip(cols, heads, widths):
            self.tree_reports.heading(c, text=h)
            self.tree_reports.column(c, width=w, anchor="w",
                                     stretch=(c == "contract"))
        vs = ttk.Scrollbar(wrap, orient="vertical",
                           command=self.tree_reports.yview)
        hs = ttk.Scrollbar(wrap, orient="horizontal",
                           command=self.tree_reports.xview)
        self.tree_reports.configure(yscrollcommand=vs.set, xscrollcommand=hs.set)
        self.tree_reports.grid(row=0, column=0, sticky="nsew")
        vs.grid(row=0, column=1, sticky="ns")
        hs.grid(row=1, column=0, sticky="ew")
        wrap.rowconfigure(0, weight=1)
        wrap.columnconfigure(0, weight=1)
        self.tree_reports.tag_configure("scrapped", background=RED_BG,
                                        foreground=RED_FG)
        self.tree_reports.bind("<<TreeviewSelect>>", self._on_pick_report)
        self.tree_reports.bind("<Double-1>", lambda _e: self.tabs.select(1))

        foot = tk.Frame(f, bg=BODY_BG, pady=8)
        foot.pack(fill="x")
        self.summary_lbl = tk.Label(foot, text="", bg=BODY_BG,
                                    fg=BODY_FG, font=("Arial", 10),
                                    justify="left", anchor="w")
        self.summary_lbl.pack(side="left", padx=4)

    def _build_detail_tab(self):
        f = self.tab_detail

        top = tk.Frame(f, bg=BAR_BG, pady=8)
        top.pack(fill="x", pady=(8, 0))
        self.detail_lbl = tk.Label(top, text="Pick a report on the REPORTS tab.",
                                   bg=BAR_BG, fg=BODY_FG,
                                   font=("Arial", 11, "bold"), anchor="w",
                                   justify="left")
        self.detail_lbl.pack(side="left", padx=14)
        self._button(top, "📄  Export PDF", lambda: export_pdf(self),
                     "#1a3a5c").pack(side="right", padx=(0, 14))
        self._button(top, "📊  Export Excel", lambda: export_excel(self),
                     "#1a3a5c").pack(side="right", padx=(0, 8))
        self.save_btn = self._button(top, "💾  Save Serials", self.save_serials,
                                     "#2e7d32")
        self.save_btn.pack(side="right", padx=(0, 8))
        self.count_lbl = tk.Label(top, text="", bg=BAR_BG,
                                  fg=MUTED, font=("Arial", 9))
        self.count_lbl.pack(side="right", padx=(0, 14))

        hint = tk.Label(
            f, bg=BODY_BG, fg=MUTED, font=("Arial", 9),
            anchor="w", justify="left",
            text=("Type the engraved number against each casting — the NUMBER "
                  "only, no prefix. Enter moves to the next one. A casting "
                  "shown in red failed at least one angle: it is scrapped and "
                  "goes back to Vestcast, but it still needs its serial so you "
                  "know which one it is."))
        hint.pack(fill="x", padx=6, pady=(6, 2))

        body = tk.Frame(f, bg=BODY_BG)
        body.pack(fill="both", expand=True)
        self.canvas = tk.Canvas(body, bg=BODY_BG, highlightthickness=0)
        sb = ttk.Scrollbar(body, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=sb.set)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        sb.grid(row=0, column=1, sticky="ns")
        body.rowconfigure(0, weight=1)
        body.columnconfigure(0, weight=1)
        self.rows_frame = tk.Frame(self.canvas, bg=BODY_BG)
        self._rows_window = self.canvas.create_window(
            (0, 0), window=self.rows_frame, anchor="nw")
        self.rows_frame.bind(
            "<Configure>",
            lambda _e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind(
            "<Configure>",
            lambda e: self.canvas.itemconfigure(self._rows_window, width=e.width))
        for seq in ("<MouseWheel>", "<Button-4>", "<Button-5>"):
            self.canvas.bind_all(seq, self._wheel)

    def _wheel(self, event):
        if not self.winfo_exists() or self.tabs.index(self.tabs.select()) != 1:
            return
        if getattr(event, "num", None) == 4:
            self.canvas.yview_scroll(-3, "units")
        elif getattr(event, "num", None) == 5:
            self.canvas.yview_scroll(3, "units")
        else:
            self.canvas.yview_scroll(int(-1 * (event.delta / 40)), "units")

    # ─────────────────────────────────────────────────────────────────────
    # FAULT REPORT — which angle fails most, and what it fails on
    #
    # Gerhard 23/11/2026: "so we can draw stats on which one fails the most to
    # determine where the issue are and try and fix it in the next casting".
    #
    # A casting is shot from four angles, A B C D. If the SAME angle keeps
    # failing across a batch the fault is likely in the same place on the mould
    # or the gating every time, not scattered at random — that is what makes
    # counting them worth anything. The same goes for the position on the tree:
    # TREE 4-192-3 is position 3 on tree 4-192, and one leg of the tree filling
    # badly shows up here before anyone notices it on the floor.
    #
    # Everything here is counted from what Gammex actually wrote in
    # xray_results. Nothing is estimated and nothing is inferred.
    # ─────────────────────────────────────────────────────────────────────
    def _build_faults_tab(self):
        f = self.tab_faults
        bar = tk.Frame(f, bg=BAR_BG, pady=8)
        bar.pack(fill="x", pady=(8, 0))
        tk.Label(bar, text="FAULT REPORT", bg=BAR_BG, fg=BAR_FG,
                 font=("Arial", 12, "bold")).pack(side="left", padx=14)
        tk.Label(bar, text="counted from what Gammex recorded, per angle",
                 bg=BAR_BG, fg=BAR_MUTED, font=("Arial", 9)).pack(side="left")
        tk.Label(bar, text="Item", bg=BAR_BG, fg=BAR_MUTED,
                 font=("Arial", 9)).pack(side="left", padx=(20, 4))
        self.fault_item = tk.StringVar(value="— All items —")
        self.fault_pick = ttk.Combobox(bar, textvariable=self.fault_item, width=24,
                                       state="readonly", font=("Arial", 10))
        self.fault_pick.pack(side="left")
        self.fault_pick.bind("<<ComboboxSelected>>", lambda _e: self._draw_faults())
        self._button(bar, "↻  Refresh", self.load_faults,
                     "#1a3a5c").pack(side="left", padx=12)
        self._button(bar, "📊  Export Excel", lambda: export_faults_excel(self),
                     "#1a3a5c").pack(side="right", padx=(0, 14))

        body = tk.Frame(f, bg=BODY_BG)
        body.pack(fill="both", expand=True)
        self.fcanvas = tk.Canvas(body, bg=BODY_BG, highlightthickness=0)
        fsb = ttk.Scrollbar(body, orient="vertical", command=self.fcanvas.yview)
        self.fcanvas.configure(yscrollcommand=fsb.set)
        self.fcanvas.grid(row=0, column=0, sticky="nsew")
        fsb.grid(row=0, column=1, sticky="ns")
        body.rowconfigure(0, weight=1)
        body.columnconfigure(0, weight=1)
        self.fbox = tk.Frame(self.fcanvas, bg=BODY_BG)
        self._fwin = self.fcanvas.create_window((0, 0), window=self.fbox, anchor="nw")
        self.fbox.bind("<Configure>", lambda _e: self.fcanvas.configure(
            scrollregion=self.fcanvas.bbox("all")))
        self.fcanvas.bind("<Configure>", lambda e: self.fcanvas.itemconfigure(
            self._fwin, width=e.width))
        self._faults = None

    def load_faults(self):
        self._say("Counting the faults\u2026")

        def work():
            try:
                reps = (db_manager.db().table("xray_reports")
                        .select("id, report_no, report_date, item, order_no, "
                                "trees_count, scrapped_trees")
                        .limit(2000).execute().data or [])
                res, trees = [], []
                ids = [r["id"] for r in reps]
                for i in range(0, len(ids), 40):
                    chunk = ids[i:i + 40]
                    res.extend(db_manager.db().table("xray_results")
                               .select("report_id, tree_no, position, interpretation, result")
                               .in_("report_id", chunk).limit(80000).execute().data or [])
                    trees.extend(db_manager.db().table("xray_trees")
                                 .select("report_id, tree_no, item, result")
                                 .in_("report_id", chunk).limit(40000).execute().data or [])
                err = None
            except Exception as e:
                db_manager.matrix_errors.report("frm_xray.load_faults", e, "")
                reps, res, trees, err = [], [], [], str(e)
            self.after(0, lambda: self._faults_ready(reps, res, trees, err))
        threading.Thread(target=work, daemon=True).start()

    def _faults_ready(self, reps, res, trees, err):
        if err:
            self._say("Could not count the faults — " + err[:60], RED_FG)
            return
        self._faults = {"reports": reps, "results": res, "trees": trees}
        items = sorted({(r.get("item") or "").strip() for r in reps
                        if (r.get("item") or "").strip()})
        self.fault_pick["values"] = ["— All items —"] + items
        if self.fault_item.get() not in self.fault_pick["values"]:
            self.fault_item.set("— All items —")
        self._say("%d report(s) counted" % len(reps))
        self._draw_faults()

    def _draw_faults(self):
        for w in self.fbox.winfo_children():
            w.destroy()
        if not self._faults:
            tk.Label(self.fbox, text="Press Refresh to count the faults.",
                     bg=BODY_BG, fg=MUTED, font=("Arial", 10)
                     ).grid(row=0, column=0, padx=14, pady=14, sticky="w")
            return
        rows = faults_summary(self._faults, self.fault_item.get())
        if not rows["angles"]:
            tk.Label(self.fbox,
                     text="No X-ray results to count yet for this item.",
                     bg=BODY_BG, fg=MUTED, font=("Arial", 10)
                     ).grid(row=0, column=0, padx=14, pady=14, sticky="w")
            return
        r = 0
        r = self._fault_heading(r, "PER ANGLE — which one fails most",
                                "Each casting is shot four times. A high share on "
                                "one angle points at the same place on the mould "
                                "every time.")
        r = self._fault_angles(r, rows["angles"])
        r = self._fault_heading(r, "WHAT IT FAILED ON",
                                "The code Gammex wrote against the failed angle.")
        r = self._fault_table(r, ("Angle", "Interpretation", "Times", "On items"),
                              rows["what"], (70, 150, 70, 420))
        r = self._fault_heading(r, "PER REPORT",
                                "So a bad batch can be told apart from a bad angle.")
        r = self._fault_table(r, ("Report", "Date", "Item", "Castings", "Scrapped",
                                  "Scrap %", "A", "B", "C", "D"),
                              rows["reports"], (100, 90, 160, 80, 80, 80, 45, 45, 45, 45))
        r = self._fault_heading(r, "POSITION ON THE TREE",
                                "TREE 4-192-3 is position 3 on tree 4-192. One leg "
                                "filling badly shows here first.")
        r = self._fault_table(r, ("Position", "Castings", "Scrapped", "Scrap %",
                                  "On items"), rows["positions"],
                              (90, 90, 90, 90, 420))
        self.fbox.columnconfigure(0, weight=1)

    def _fault_heading(self, r, title, note):
        box = tk.Frame(self.fbox, bg=BODY_BG)
        box.grid(row=r, column=0, sticky="ew", padx=10, pady=(16, 4))
        tk.Label(box, text=title, bg=BODY_BG, fg=BAR_FG,
                 font=("Arial", 11, "bold"), anchor="w").pack(anchor="w")
        tk.Label(box, text=note, bg=BODY_BG, fg=MUTED,
                 font=("Arial", 9), anchor="w", justify="left").pack(anchor="w")
        return r + 1

    def _fault_angles(self, r, angles):
        """A bar per angle, drawn to the share of all failures."""
        wrap = tk.Frame(self.fbox, bg=BODY_BG)
        wrap.grid(row=r, column=0, sticky="ew", padx=14, pady=(4, 2))
        worst = max((a["failed"] for a in angles), default=0)
        for i, a in enumerate(angles):
            tk.Label(wrap, text=a["angle"], bg=BODY_BG, fg=BODY_FG,
                     font=("Arial", 13, "bold"), width=3
                     ).grid(row=i, column=0, sticky="w")
            cv = tk.Canvas(wrap, height=22, bg=BODY_BG, highlightthickness=0, width=520)
            cv.grid(row=i, column=1, sticky="w", pady=2)
            if worst:
                w = int(510 * a["failed"] / worst)
                if a["failed"] and w < 3:
                    w = 3
                cv.create_rectangle(0, 4, max(w, 0), 18, fill=RED_FG, outline="")
            tk.Label(wrap,
                     text="%d of %d failed  ·  %.2f%%  ·  %.0f%% of all failures"
                          % (a["failed"], a["shot"], a["fail_pct"], a["share_pct"]),
                     bg=BODY_BG, fg=(RED_FG if a["failed"] else MUTED),
                     font=("Arial", 10, "bold" if a["failed"] == worst and worst else "normal"),
                     anchor="w").grid(row=i, column=2, sticky="w", padx=10)
        return r + 1

    def _fault_table(self, r, heads, data, widths):
        wrap = tk.Frame(self.fbox, bg=BODY_BG)
        wrap.grid(row=r, column=0, sticky="ew", padx=14, pady=(2, 6))
        for c, (h, w) in enumerate(zip(heads, widths)):
            tk.Label(wrap, text=h, bg=BAR_BG, fg=BAR_FG, font=("Arial", 9, "bold"),
                     anchor="w", padx=6, pady=3
                     ).grid(row=0, column=c, sticky="ew", padx=1)
            wrap.columnconfigure(c, minsize=w)
        for i, row in enumerate(data, start=1):
            for c, v in enumerate(row):
                tk.Label(wrap, text=str(v), bg=BODY_BG, fg=BODY_FG,
                         font=("Arial", 9), anchor="w", padx=6, pady=2
                         ).grid(row=i, column=c, sticky="ew", padx=1)
        return r + 1

    # ── loading ─────────────────────────────────────────────────────────────
    def _say(self, text, colour=None):
        try:
            self.status.config(text=text, fg=colour or BAR_MUTED)
        except Exception:
            pass

    def _load_lists(self):
        """The country and contract lists — the same two the Blue Card uses,
        so the two screens can never drift apart."""
        def work():
            countries, contracts = [], []
            try:
                countries = [r["name"] for r in (
                    db_manager.db().table("countries").select("name")
                    .order("name").execute().data or []) if r.get("name")]
            except Exception as e:
                db_manager.matrix_errors.report("frm_xray._load_lists", e, "countries")
            try:
                contracts = [r["name"] for r in (
                    db_manager.db().table("bluecard_contracts").select("name")
                    .order("name").execute().data or []) if r.get("name")]
            except Exception as e:
                db_manager.matrix_errors.report("frm_xray._load_lists", e, "contracts")
            self.after(0, lambda: self._lists_ready(countries, contracts))
        threading.Thread(target=work, daemon=True).start()

    def _lists_ready(self, countries, contracts):
        self._countries, self._contracts = countries, contracts

    def reload_reports(self):
        if self._busy:
            return
        self._busy = True
        self._say("Loading reports…")

        def work():
            try:
                rows = (db_manager.db().table("xray_reports").select("*")
                        .order("report_date", desc=True)
                        .order("report_no", desc=True)
                        .limit(2000).execute().data or [])
                err = None
            except Exception as e:
                db_manager.matrix_errors.report("frm_xray.reload_reports", e, "")
                rows, err = [], str(e)
            self.after(0, lambda: self._reports_ready(rows, err))
        threading.Thread(target=work, daemon=True).start()

    def _reports_ready(self, rows, err):
        self._busy = False
        if err:
            self._say("Could not load — " + err[:70], "#ff8a80")
            messagebox.showerror("X-Ray Reports",
                                 "The reports could not be read:\n\n" + err,
                                 parent=self)
            return
        self._reports = rows
        items = sorted({(r.get("item") or "").strip() for r in rows
                        if (r.get("item") or "").strip()})
        self.item_pick["values"] = ["— All items —"] + items
        if self.item_var.get() not in self.item_pick["values"]:
            self.item_var.set("— All items —")
        self._say("%d report(s)" % len(rows))
        self._apply_filter()

    def _apply_filter(self):
        term = (self.search_var.get() or "").strip().upper()
        item = self.item_var.get()
        rows = []
        for r in self._reports:
            if item and not item.startswith("—") and (r.get("item") or "") != item:
                continue
            if term:
                hay = " ".join(str(r.get(k) or "") for k in
                               ("report_no", "order_no", "job_no", "item",
                                "contract_name", "client_country")).upper()
                if term not in hay:
                    continue
            rows.append(r)
        self._shown = rows
        self.tree_reports.delete(*self.tree_reports.get_children())
        for r in rows:
            scrap = int(r.get("scrapped_trees") or 0)
            self.tree_reports.insert(
                "", "end", iid=r["id"],
                values=(r.get("report_no", ""), r.get("report_date") or "",
                        r.get("item") or "", r.get("order_no") or "",
                        r.get("job_no") or "",
                        r.get("trees_count") or 0,
                        scrap if scrap else "",
                        "", r.get("client_country") or "",
                        r.get("contract_name") or ""),
                tags=("scrapped",) if scrap else ())
        self.summary_lbl.config(
            text="%d of %d report(s) shown   ·   %d casting(s) scrapped in view"
                 % (len(rows), len(self._reports),
                    sum(int(r.get("scrapped_trees") or 0) for r in rows)))
        self._fill_serial_counts(rows)

    def _fill_serial_counts(self, rows):
        """How many serials are already typed in, per report."""
        ids = [r["id"] for r in rows][:300]
        if not ids:
            return

        def work():
            counts = {}
            try:
                for i in range(0, len(ids), 50):
                    data = (db_manager.db().table("xray_trees")
                            .select("report_id,serial")
                            .in_("report_id", ids[i:i + 50])
                            .limit(20000).execute().data or [])
                    for row in data:
                        key = row["report_id"]
                        c = counts.setdefault(key, 0)
                        if (row.get("serial") or "").strip():
                            counts[key] = c + 1
                        else:
                            counts[key] = c
            except Exception as e:
                db_manager.matrix_errors.report("frm_xray._fill_serial_counts", e, "")
                return
            self.after(0, lambda: self._serial_counts_ready(counts))
        threading.Thread(target=work, daemon=True).start()

    def _serial_counts_ready(self, counts):
        for r in getattr(self, "_shown", []):
            if not self.tree_reports.exists(r["id"]):
                continue
            total = int(r.get("trees_count") or 0)
            got = counts.get(r["id"], 0)
            self.tree_reports.set(r["id"], "serials",
                                  "%d of %d" % (got, total) if total else "")

    def _on_pick_report(self, _event=None):
        sel = self.tree_reports.selection()
        if not sel:
            return
        rid = sel[0]
        self._report = next((r for r in self._reports if r["id"] == rid), None)
        if not self._report:
            return
        self._load_detail(rid)

    def _load_detail(self, report_id):
        self._say("Loading castings…")

        def work():
            try:
                trees = (db_manager.db().table("xray_trees").select("*")
                         .eq("report_id", report_id).order("line_no")
                         .limit(20000).execute().data or [])
                results = (db_manager.db().table("xray_results").select("*")
                           .eq("report_id", report_id)
                           .limit(80000).execute().data or [])
                err = None
            except Exception as e:
                db_manager.matrix_errors.report("frm_xray._load_detail", e, report_id)
                trees, results, err = [], [], str(e)
            self.after(0, lambda: self._detail_ready(trees, results, err))
        threading.Thread(target=work, daemon=True).start()

    def _detail_ready(self, trees, results, err):
        if err:
            self._say("Could not load the castings — " + err[:60], "#ff8a80")
            return
        self._trees, self._results = trees, results
        self._say("%d casting(s)" % len(trees))
        self._render_rows()

    # ── the casting rows, with the serial boxes ─────────────────────────────
    def _render_rows(self):
        for w in self.rows_frame.winfo_children():
            w.destroy()
        self._serial_vars = {}
        self._serial_prefix = {}
        self._serial_entries = []
        r = self._report or {}
        self.detail_lbl.config(
            text="%s   ·   %s   ·   order %s   ·   %s   ·   %s"
                 % (r.get("report_no", "?"), r.get("item") or "?",
                    r.get("order_no") or "?", r.get("client_country") or "—",
                    r.get("contract_name") or "—"))
        if not self._trees:
            tk.Label(self.rows_frame, text="Pick a report on the REPORTS tab.",
                     bg=BODY_BG, fg=MUTED,
                     font=("Arial", 10)).grid(row=0, column=0, padx=12, pady=12)
            self.count_lbl.config(text="")
            return

        by_tree = {}
        for x in self._results:
            by_tree.setdefault(x["tree_no"], []).append(x)

        heads = ("#", "Casting (tree)", "Serial — number only",
                 "A", "B", "C", "D", "Interpretation (A / B / C / D)", "Casting")
        widths = (4, 20, 22, 4, 4, 4, 4, 42, 11)
        for c, (h, w) in enumerate(zip(heads, widths)):
            tk.Label(self.rows_frame, text=h, bg=BAR_BG,
                     fg=MUTED, font=("Arial", 9, "bold"),
                     width=w, anchor="w", padx=4, pady=4
                     ).grid(row=0, column=c, sticky="ew", padx=1, pady=(0, 2))

        for i, t in enumerate(self._trees, start=1):
            angles = {a["position"]: a for a in by_tree.get(t["tree_no"], [])}
            bad = (t.get("result") or "") == "REJECTED"
            bg = RED_BG if bad else BODY_BG
            fg = RED_FG if bad else BODY_FG

            tk.Label(self.rows_frame, text=str(i), bg=bg, fg=fg,
                     font=("Arial", 9), width=4, anchor="w", padx=4
                     ).grid(row=i, column=0, sticky="ew", padx=1)
            tk.Label(self.rows_frame, text=t["tree_no"], bg=bg, fg=fg,
                     font=("Arial", 10, "bold" if bad else "normal"),
                     width=20, anchor="w", padx=4
                     ).grid(row=i, column=1, sticky="ew", padx=1)

            # 23/11/2026 (Gerhard): the prefix is shown in front of the box —
            # HFM- for a TREE 4 (Housing Front Main), HRC- for a TREE 5 (Rear
            # Cross) — so only the number is typed. The stored value is still
            # the number alone.
            prefix = serial_prefix(t.get("item") or (self._report or {}).get("item"),
                                   t["tree_no"])
            cell = tk.Frame(self.rows_frame, bg=bg)
            cell.grid(row=i, column=2, sticky="ew", padx=3)
            if prefix:
                tk.Label(cell, text=prefix, bg=bg, fg=MUTED,
                         font=("Arial", 10, "bold")).pack(side="left", padx=(2, 1))
            var = tk.StringVar(value=t.get("serial") or "")
            self._serial_vars[t["tree_no"]] = var
            ent = tk.Entry(cell, textvariable=var, width=18 if prefix else 22,
                           bg=FIELD_BG, fg=BODY_FG,
                           insertbackground=FIELD_FG, font=("Arial", 10),
                           relief="flat")
            ent.pack(side="left", fill="x", expand=True, ipady=2)
            self._serial_prefix[t["tree_no"]] = prefix
            ent.bind("<Return>", self._next_entry)
            ent.bind("<Down>", self._next_entry)
            ent.bind("<Up>", self._prev_entry)
            self._serial_entries.append(ent)

            for c, a in enumerate("ABCD", start=3):
                row = angles.get(a, {})
                ok = (row.get("result") or "").upper() == "PASS"
                tk.Label(self.rows_frame, text=("✓" if ok else "✗") if row else "",
                         bg=bg, fg=(OK_FG if ok else RED_FG),
                         font=("Arial", 10, "bold"), width=4
                         ).grid(row=i, column=c, sticky="ew", padx=1)

            interp = " / ".join((angles.get(a, {}).get("interpretation") or "–")
                                for a in "ABCD")
            tk.Label(self.rows_frame, text=interp, bg=bg, fg=fg,
                     font=("Arial", 9), width=42, anchor="w", padx=4
                     ).grid(row=i, column=7, sticky="ew", padx=1)
            tk.Label(self.rows_frame,
                     text="SCRAPPED" if bad else "PASS", bg=bg,
                     fg=(RED_FG if bad else OK_FG),
                     font=("Arial", 9, "bold"), width=11, anchor="w", padx=4
                     ).grid(row=i, column=8, sticky="ew", padx=1)

        self.rows_frame.columnconfigure(7, weight=1)
        for v in self._serial_vars.values():
            v.trace_add("write", lambda *_a: self._update_count())
        self._update_count()

    def _update_count(self):
        total = len(self._serial_vars)
        got = sum(1 for v in self._serial_vars.values() if (v.get() or "").strip())
        self.count_lbl.config(text="%d of %d serials filled in" % (got, total))

    def _next_entry(self, event):
        try:
            i = self._serial_entries.index(event.widget)
        except ValueError:
            return
        if i + 1 < len(self._serial_entries):
            nxt = self._serial_entries[i + 1]
            nxt.focus_set()
            nxt.select_range(0, "end")
            self.canvas.yview_moveto(
                max(0.0, (i + 1) / max(1, len(self._serial_entries)) - 0.15))
        return "break"

    def _prev_entry(self, event):
        try:
            i = self._serial_entries.index(event.widget)
        except ValueError:
            return
        if i > 0:
            prv = self._serial_entries[i - 1]
            prv.focus_set()
            prv.select_range(0, "end")
        return "break"

    # ── saving the serials ──────────────────────────────────────────────────
    def save_serials(self):
        if not self._report or not self._trees:
            messagebox.showinfo("X-Ray Reports",
                                "Pick a report first.", parent=self)
            return
        changes = []
        for t in self._trees:
            was = (t.get("serial") or "").strip()
            now = strip_serial_prefix(
                self._serial_vars.get(t["tree_no"], tk.StringVar()).get(),
                self._serial_prefix.get(t["tree_no"], ""))
            if now != was:
                changes.append((t, now))
        if not changes:
            messagebox.showinfo("X-Ray Reports",
                                "Nothing has changed — no serial was added or "
                                "altered.", parent=self)
            return

        # a number twice in the same report is a typing slip, caught here before
        # the database refuses it one row at a time
        typed = {}
        for t in self._trees:
            v = strip_serial_prefix(
                self._serial_vars.get(t["tree_no"], tk.StringVar()).get(),
                self._serial_prefix.get(t["tree_no"], "")).upper()
            if v:
                typed.setdefault(v, []).append(t["tree_no"])
        clashes = {k: v for k, v in typed.items() if len(v) > 1}
        if clashes:
            lines = ["%s is on %s" % (k, " and ".join(v))
                     for k, v in sorted(clashes.items())][:8]
            messagebox.showerror(
                "X-Ray Reports",
                "The same serial is on more than one casting in this report. "
                "Nothing has been saved — please correct these first:\n\n"
                + "\n".join(lines), parent=self)
            return

        if not messagebox.askyesno(
                "X-Ray Reports",
                "Save %d serial(s) on report %s?\n\nNothing else on the report "
                "is changed." % (len(changes), self._report.get("report_no", "?")),
                parent=self):
            return

        self.save_btn.config(state="disabled")
        self._say("Saving %d serial(s)…" % len(changes))
        user = db_manager.CURRENT_USER or ""
        stamp = datetime.now().astimezone().isoformat()
        rid = self._report["id"]

        def work():
            done, failed = 0, []
            for t, serial in changes:
                try:
                    (db_manager.db().table("xray_trees").update({
                        "serial": serial or None,
                        "serial_by": user or None,
                        "serial_at": stamp if serial else None,
                    }).eq("id", t["id"]).execute())
                    done += 1
                except Exception as e:
                    msg = str(e)
                    if "xray_trees_item_serial_uk" in msg:
                        msg = ("%s is already engraved on another casting of "
                               "this item" % serial)
                    failed.append("%s — %s" % (t["tree_no"], msg[:90]))
                    db_manager.matrix_errors.report(
                        "frm_xray.save_serials", e, "%s %s" % (t["tree_no"], serial))
            self.after(0, lambda: self._saved(rid, done, failed))
        threading.Thread(target=work, daemon=True).start()

    def _saved(self, report_id, done, failed):
        self.save_btn.config(state="normal")
        self._say("%d serial(s) saved" % done, OK_FG if not failed else "#ffb74d")
        if failed:
            messagebox.showerror(
                "X-Ray Reports",
                "%d serial(s) saved. %d could NOT be saved:\n\n%s"
                % (done, len(failed), "\n".join(failed[:10])), parent=self)
        self._load_detail(report_id)
        self._fill_serial_counts(getattr(self, "_shown", []))

    # ── importing a Gammex PDF ──────────────────────────────────────────────
    def import_pdf(self):
        path = filedialog.askopenfilename(
            parent=self, title="Choose the Gammex radiographic report (PDF)",
            filetypes=[("Gammex report (PDF)", "*.pdf"), ("All files", "*.*")])
        if not path:
            return
        try:
            import pdfplumber                      # noqa: F401
        except Exception as e:
            messagebox.showerror(
                "X-Ray Reports",
                "This laptop cannot read PDFs:\n\n%s\n\nIt needs the PDF parts "
                "that come with the Matrix release (pdfplumber)." % e, parent=self)
            return

        self._say("Reading %s…" % os.path.basename(path))
        try:
            header, trees, lines = read_gammex_pdf(path)
        except Exception as e:
            db_manager.matrix_errors.report("frm_xray.import_pdf", e, path)
            self._say("Could not read the PDF", "#ff8a80")
            messagebox.showerror("X-Ray Reports",
                                 "That file could not be read as a PDF:\n\n%s" % e,
                                 parent=self)
            return

        problems = verify_report(header, trees, lines)
        if problems:
            self._say("The report did not come out whole", "#ff8a80")
            messagebox.showerror(
                "X-Ray Reports — nothing imported",
                "This report did not come out whole, so NOTHING has been "
                "saved:\n\n- " + "\n- ".join(problems)
                + "\n\nSend me the PDF and I will look at why.", parent=self)
            return

        ImportDialog(self, header, trees, lines, os.path.basename(path))


# ─────────────────────────────────────────────────────────────────────────────
# IMPORT DIALOG — shows what was read, asks for the country and the contract
# ─────────────────────────────────────────────────────────────────────────────
class ImportDialog(tk.Toplevel):
    def __init__(self, parent, header, trees, lines, filename):
        super().__init__(parent)
        self.parent = parent
        self.header, self.trees, self.lines = header, trees, lines
        self.filename = filename
        self.title("Import Gammex report — %s" % header.get("REPORT NO", "?"))
        self.configure(bg=BODY_BG)
        self.transient(parent)
        self.grab_set()
        self.resizable(False, False)

        tk.Label(self, text="THIS IS WHAT THE REPORT CONTAINS",
                 bg=BODY_BG, fg=BAR_FG, font=("Arial", 11, "bold")
                 ).pack(anchor="w", padx=16, pady=(14, 6))
        tk.Label(self, text=import_summary(header, trees, lines),
                 bg=BODY_BG, fg=BODY_FG, font=("Arial", 10),
                 justify="left", anchor="w").pack(anchor="w", padx=16)

        box = tk.Frame(self, bg=BAR_BG, pady=10)
        box.pack(fill="x", padx=16, pady=12)
        tk.Label(box, text="Gammex have no way of knowing these two — pick them:",
                 bg=BAR_BG, fg=MUTED,
                 font=("Arial", 9)).grid(row=0, column=0, columnspan=2,
                                         sticky="w", padx=12, pady=(0, 8))
        tk.Label(box, text="Country", bg=BAR_BG, fg=BODY_FG,
                 font=("Arial", 10)).grid(row=1, column=0, sticky="w", padx=12)
        self.country = ttk.Combobox(box, values=parent._countries, width=30,
                                    state="readonly", font=("Arial", 10))
        self.country.grid(row=1, column=1, sticky="w", padx=12, pady=3)
        tk.Label(box, text="Contract", bg=BAR_BG, fg=BODY_FG,
                 font=("Arial", 10)).grid(row=2, column=0, sticky="w", padx=12)
        self.contract = ttk.Combobox(box, values=parent._contracts, width=30,
                                     state="readonly", font=("Arial", 10))
        self.contract.grid(row=2, column=1, sticky="w", padx=12, pady=3)

        scrap = sorted(scrapped_trees(lines))
        if scrap:
            tk.Label(self,
                     text=("%d casting(s) are SCRAPPED — they failed at least "
                           "one angle and go back to Vestcast:\n%s"
                           % (len(scrap), _some(scrap, 8))),
                     bg=BODY_BG, fg=RED_FG, font=("Arial", 9),
                     justify="left", anchor="w").pack(anchor="w", padx=16,
                                                      pady=(0, 10))

        row = tk.Frame(self, bg=BODY_BG, pady=8)
        row.pack(fill="x", padx=16, pady=(0, 12))
        self.go = parent._button(row, "📥  Import this report", self._do,
                                 "#2e7d32")
        self.go.pack(side="right")
        parent._button(row, "Cancel", self.destroy, "#1a3a5c").pack(
            side="right", padx=(0, 8))
        self.note = tk.Label(row, text="", bg=BODY_BG,
                             fg=MUTED, font=("Arial", 9))
        self.note.pack(side="left")

        self.update_idletasks()
        x = parent.winfo_rootx() + 80
        y = parent.winfo_rooty() + 70
        self.geometry("+%d+%d" % (max(0, x), max(0, y)))

    def _do(self):
        country = self.country.get().strip()
        contract = self.contract.get().strip()
        if not country or not contract:
            messagebox.showinfo("Import",
                                "Pick the country and the contract first — "
                                "Gammex do not put them on the report.",
                                parent=self)
            return
        self.go.config(state="disabled")
        self.note.config(text="Importing…")
        user = db_manager.CURRENT_USER or ""
        header, trees, lines = self.header, self.trees, self.lines

        def work():
            try:
                row = report_row(header, trees, lines, country, contract,
                                 self.filename, user)
                res = (db_manager.db().table("xray_reports")
                       .insert(row).execute())
                rid = (res.data or [{}])[0].get("id")
                if not rid:
                    raise RuntimeError("the report row came back without an id")

                db_manager.db().table("xray_trees").insert(
                    tree_rows(rid, header, trees, lines)).execute()

                saved = (db_manager.db().table("xray_trees")
                         .select("id,tree_no").eq("report_id", rid)
                         .limit(20000).execute().data or [])
                ids = {r["tree_no"]: r["id"] for r in saved}
                rows, lost = result_rows(rid, ids, lines)
                if lost:
                    raise RuntimeError(
                        "%d result line(s) had no casting to belong to (%s)"
                        % (len(lost), _some(sorted(set(lost)), 5)))
                for i in range(0, len(rows), 500):
                    db_manager.db().table("xray_results").insert(
                        rows[i:i + 500]).execute()
                err = None
            except Exception as e:
                db_manager.matrix_errors.report(
                    "frm_xray.ImportDialog", e, header.get("REPORT NO", ""))
                err = str(e)
            self.after(0, lambda: self._done(err))
        threading.Thread(target=work, daemon=True).start()

    def _done(self, err):
        self.go.config(state="normal")
        self.note.config(text="")
        if err:
            if "xray_reports_report_no_uk" in err:
                messagebox.showerror(
                    "Import", "Report %s has already been imported. Nothing "
                              "has been changed — search for it on the REPORTS "
                              "tab." % self.header.get("REPORT NO", "?"),
                    parent=self)
            else:
                messagebox.showerror("Import",
                                     "The report could not be imported:\n\n" + err,
                                     parent=self)
            return
        messagebox.showinfo(
            "Import",
            "Report %s imported — %d castings, %d result lines.\n\nNow type the "
            "engraved serials against each casting on the CASTINGS & SERIALS "
            "tab." % (self.header.get("REPORT NO", "?"), len(self.trees),
                      len(self.lines)), parent=self)
        self.destroy()
        self.parent.reload_reports()


# ─────────────────────────────────────────────────────────────────────────────
# EXPORTS
# ─────────────────────────────────────────────────────────────────────────────
def _export_path(parent, report, extension, what):
    name = "XRAY_%s_%s" % ((report.get("report_no") or "report").replace(" ", ""),
                           (report.get("item") or "").replace(" ", "_"))
    return filedialog.asksaveasfilename(
        parent=parent, title="Save the %s" % what, defaultextension=extension,
        initialfile=name + extension,
        filetypes=[(what, "*" + extension), ("All files", "*.*")])


def export_excel(self):
    """Excel: a flat sheet to work with. Called with the X-Ray window."""
    if not self._report or not self._trees:
        messagebox.showinfo("X-Ray Reports", "Pick a report first.",
                            parent=self)
        return
    path = _export_path(self, self._report, ".xlsx", "Excel workbook")
    if not path:
        return
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment
        from openpyxl.utils import get_column_letter
    except Exception as e:
        messagebox.showerror("X-Ray Reports",
                             "Excel export needs openpyxl:\n\n%s" % e,
                             parent=self)
        return
    try:
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "X-Ray Results"
        r = self._report
        ws.append(["GAMMEX RADIOGRAPHIC EXAMINATION — %s"
                   % (r.get("report_no") or "")])
        ws["A1"].font = Font(bold=True, size=13)
        ws.append(["Item", r.get("item") or "", "Order No",
                   r.get("order_no") or "", "Job No", r.get("job_no") or ""])
        ws.append(["Country", r.get("client_country") or "", "Contract",
                   r.get("contract_name") or "", "Report date",
                   str(r.get("report_date") or "")])
        ws.append(["Castings", r.get("trees_count") or 0, "Result lines",
                   r.get("lines_count") or 0, "Scrapped castings",
                   r.get("scrapped_trees") or 0])
        ws.append([])
        head_row = ws.max_row + 1
        ws.append(list(EXPORT_COLUMNS))
        fill = PatternFill("solid", fgColor="1A3A5C")
        for c in range(1, len(EXPORT_COLUMNS) + 1):
            cell = ws.cell(row=head_row, column=c)
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = fill
            cell.alignment = Alignment(horizontal="center")
        red = PatternFill("solid", fgColor="FFC7CE")
        red_font = Font(color="9C0006", bold=True)
        for row in export_rows(r, self._trees, self._results):
            ws.append(row)
            if is_scrapped_row(row):
                # the WHOLE casting goes red, not only the angle that failed
                for c in range(1, len(EXPORT_COLUMNS) + 1):
                    cell = ws.cell(row=ws.max_row, column=c)
                    cell.fill = red
                    cell.font = red_font
        for c, width in enumerate((12, 11, 18, 15, 10, 14, 22, 16, 18, 14,
                                   12, 12, 7, 20, 14), start=1):
            ws.column_dimensions[get_column_letter(c)].width = width
        ws.freeze_panes = ws.cell(row=head_row + 1, column=1)
        wb.save(path)
    except Exception as e:
        db_manager.matrix_errors.report("frm_xray.export_excel", e, path)
        messagebox.showerror("X-Ray Reports",
                             "The Excel file could not be written:\n\n%s" % e,
                             parent=self)
        return
    self._say("Excel saved")
    if messagebox.askyesno("X-Ray Reports",
                           "Saved:\n%s\n\nOpen it now?" % path, parent=self):
        try:
            os.startfile(path)                      # noqa
        except Exception:
            pass

def export_pdf(self):
    """PDF: the recognised layout, internal use."""
    if not self._report or not self._trees:
        messagebox.showinfo("X-Ray Reports", "Pick a report first.",
                            parent=self)
        return
    path = _export_path(self, self._report, ".pdf", "PDF")
    if not path:
        return
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib import colors
        from reportlab.lib.units import mm
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.platypus import (SimpleDocTemplate, Paragraph, Table,
                                        TableStyle, Spacer)
    except Exception as e:
        messagebox.showerror("X-Ray Reports",
                             "PDF export needs reportlab:\n\n%s" % e,
                             parent=self)
        return
    try:
        r = self._report
        doc = SimpleDocTemplate(
            path, pagesize=A4, leftMargin=12 * mm, rightMargin=12 * mm,
            topMargin=12 * mm, bottomMargin=12 * mm,
            title="X-Ray Report %s" % (r.get("report_no") or ""))
        h1 = ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=13,
                            spaceAfter=4)
        h2 = ParagraphStyle("h2", fontName="Helvetica", fontSize=8.5,
                            leading=11)
        flow = [Paragraph("RADIOGRAPHIC EXAMINATION — RESULTS WITH SERIALS", h1),
                Paragraph("Report %s &nbsp;·&nbsp; %s &nbsp;·&nbsp; order %s "
                          "&nbsp;·&nbsp; job %s &nbsp;·&nbsp; %s"
                          % (r.get("report_no") or "", r.get("item") or "",
                             r.get("order_no") or "", r.get("job_no") or "",
                             r.get("report_date") or ""), h2),
                Paragraph("Country %s &nbsp;·&nbsp; contract %s "
                          "&nbsp;·&nbsp; %d castings &nbsp;·&nbsp; "
                          "<b>%d scrapped</b>"
                          % (r.get("client_country") or "—",
                             r.get("contract_name") or "—",
                             r.get("trees_count") or 0,
                             r.get("scrapped_trees") or 0), h2),
                Spacer(1, 5 * mm)]

        head = ["Casting", "Serial", "Angle", "Density", "IQI",
                "Interpretation", "Result"]
        data = [head]
        style = [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1A3A5C")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 7.5),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#999999")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("REPEATROWS", (0, 0), (-1, 0)),
        ]
        for row in export_rows(r, self._trees, self._results):
            data.append([row[7], row[8], row[12], row[10], row[11],
                         row[13], row[14]])
            if is_scrapped_row(row):
                # Gerhard 23/11/2026: the whole casting block in red
                n = len(data) - 1
                style.append(("BACKGROUND", (0, n), (-1, n),
                              colors.HexColor("#FFC7CE")))
                style.append(("TEXTCOLOR", (0, n), (-1, n),
                              colors.HexColor("#9C0006")))
                style.append(("FONTNAME", (0, n), (-1, n), "Helvetica-Bold"))
        table = Table(data, repeatRows=1,
                      colWidths=[30 * mm, 30 * mm, 12 * mm, 20 * mm,
                                 14 * mm, 40 * mm, 22 * mm])
        table.setStyle(TableStyle(style))
        flow.append(table)
        doc.build(flow)
    except Exception as e:
        db_manager.matrix_errors.report("frm_xray.export_pdf", e, path)
        messagebox.showerror("X-Ray Reports",
                             "The PDF could not be written:\n\n%s" % e,
                             parent=self)
        return
    self._say("PDF saved")
    if messagebox.askyesno("X-Ray Reports",
                           "Saved:\n%s\n\nOpen it now?" % path, parent=self):
        try:
            os.startfile(path)                      # noqa
        except Exception:
            pass


def export_faults_excel(self):
    """The fault report as a flat workbook — one sheet per block."""
    if not getattr(self, "_faults", None):
        messagebox.showinfo("X-Ray Reports",
                            "Press Refresh on the Fault Report first.", parent=self)
        return
    rows = faults_summary(self._faults, self.fault_item.get())
    if not rows["angles"]:
        messagebox.showinfo("X-Ray Reports", "There is nothing to export yet.",
                            parent=self)
        return
    path = filedialog.asksaveasfilename(
        parent=self, title="Save the fault report", defaultextension=".xlsx",
        initialfile="XRAY_FAULT_REPORT.xlsx",
        filetypes=[("Excel workbook", "*.xlsx"), ("All files", "*.*")])
    if not path:
        return
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill
        from openpyxl.utils import get_column_letter
    except Exception as e:
        messagebox.showerror("X-Ray Reports",
                             "Excel export needs openpyxl:\n\n%s" % e, parent=self)
        return
    try:
        wb = openpyxl.Workbook()
        head_fill = PatternFill("solid", fgColor="1A3A5C")
        sheets = [
            ("Per angle", ("Angle", "Castings shot", "Failed", "Fail %",
                           "Share of all failures %"),
             [(a["angle"], a["shot"], a["failed"], a["fail_pct"], a["share_pct"])
              for a in rows["angles"]]),
            ("What failed", ("Angle", "Interpretation", "Times", "On items"),
             rows["what"]),
            ("Per report", ("Report", "Date", "Item", "Castings", "Scrapped",
                            "Scrap %", "A", "B", "C", "D"), rows["reports"]),
            ("Position on tree", ("Position", "Castings", "Scrapped", "Scrap %",
                                  "On items"), rows["positions"]),
        ]
        first = True
        for title, heads, data in sheets:
            ws = wb.active if first else wb.create_sheet()
            ws.title = title
            first = False
            ws.append(["X-RAY FAULT REPORT — %s   (%s)"
                       % (title, self.fault_item.get())])
            ws["A1"].font = Font(bold=True, size=12)
            ws.append([])
            ws.append(list(heads))
            for c in range(1, len(heads) + 1):
                cell = ws.cell(row=3, column=c)
                cell.font = Font(bold=True, color="FFFFFF")
                cell.fill = head_fill
            for row in data:
                ws.append(list(row))
            for c, h in enumerate(heads, start=1):
                ws.column_dimensions[get_column_letter(c)].width = max(12, len(h) + 6)
            ws.freeze_panes = ws.cell(row=4, column=1)
        wb.save(path)
    except Exception as e:
        db_manager.matrix_errors.report("frm_xray.export_faults_excel", e, path)
        messagebox.showerror("X-Ray Reports",
                             "The fault report could not be written:\n\n%s" % e,
                             parent=self)
        return
    self._say("Fault report saved")
    if messagebox.askyesno("X-Ray Reports",
                           "Saved:\n%s\n\nOpen it now?" % path, parent=self):
        try:
            os.startfile(path)                      # noqa
        except Exception:
            pass
