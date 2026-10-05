#!/usr/bin/env python3
"""
scripts/sb2027/mri-from-sb.py

Reads the MRI / CT (advanced imaging) cost share out of every 2027 Summary of
Benefits, using the cached `pdftotext -layout` text. No database access.

Dale's outpatient-hospital rule (2026-07-06): when an SB lists advanced imaging
by place of service, use the OUTPATIENT HOSPITAL amount. One flat amount is used
as-is. A mammogram / ultrasound / PCP-office $0 is a carve-out, never the answer.
A range resolves to its top. Only the in-network column is read.

Output: scripts/data/mri-sb-2027.json
  { "<contract>-<plan3>-<seg>": { carrier, kind: "copay"|"coins"|"none",
      value, basis, evidence } }
kind "none" = could not be read; those plans keep the CMS-filed value.

Usage: python3 scripts/sb2027/mri-from-sb.py [--only KEY,KEY] [--show KEY]
"""
import json, os, re, sys, collections

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SB = os.path.join(ROOT, '.cms-import-tmp', 'sb-2027')
MANIFEST = os.path.join(ROOT, 'scripts', 'data', 'sb-links-2027.json')
OUT = os.path.join(ROOT, 'scripts', 'data', 'mri-sb-2027.json')

DOL = re.compile(r'\$\s*([\d,]+(?:\.\d\d)?)')
PCT = re.compile(r'(\d{1,3})\s*%')
CELL = re.compile(r'\S(?:.*?\S)??(?=\s{3,}|\s*$)')


def clean(s):
    return (s.replace('﻿', '').replace('‑', '-').replace('–', '-').replace('—', '-')
             .replace(' ', ' ').replace('’', "'"))


def n(s):
    return float(s.replace(',', ''))


def cells(line):
    """[(start_col, text)] for runs separated by 3+ spaces."""
    return [(m.start(), m.group(0)) for m in CELL.finditer(line)]


def res(kind, value=None, basis=None, evidence=None):
    return {'kind': kind, 'value': value, 'basis': basis, 'evidence': re.sub(r'\s+', ' ', evidence or '').strip()[:240] or None}


def amount(text, basis, ev=None):
    """Turn a value phrase into a result. Dollars win (top of a range); else percent."""
    d = [n(x) for x in DOL.findall(text)]
    p = [float(x) for x in PCT.findall(text)]
    if d and max(d) == 0 and p and max(p) > 0:
        # "$0 copay or 20% coinsurance": the $0 is the Medicaid / carve-out case
        return res('coins', max(p), basis + '-zero-or-pct', ev or text)
    if d:
        return res('copay', max(d), basis + ('-range-max' if len(set(d)) > 1 else ''), ev or text)
    if p:
        return res('coins', max(p), basis + ('-range-max' if len(set(p)) > 1 else ''), ev or text)
    return None


def value_column(block, min_col=0):
    """In-network text of a table-row block: the leftmost column that carries a
    cost share, with any column further right (out-of-network) dropped."""
    val_start = None
    for ln in block:
        for c, t in cells(ln):
            if c >= min_col and re.search(r'[$%]|copay|coinsurance', t):
                val_start = c if val_start is None else min(val_start, c)
    if val_start is None:
        return ''
    out = []
    for ln in block:
        for c, t in cells(ln):
            if val_start - 3 <= c < val_start + 22:
                out.append(t)
    return ' '.join(out)


COST = re.compile(r'\$\s*\d|\d{1,3}\s*%|Not covered', re.I)


def slice_column(block):
    """In-network text of a fixed-position table row: characters from the column
    where the first cost share starts, up to where a second cost column starts."""
    starts = [m.start() for ln in block for m in COST.finditer(ln)]
    if not starts:
        return ''
    v = min(starts)
    nxt = [m.start() for ln in block for m in COST.finditer(ln)
           if m.start() >= v + 12 and ln[max(0, m.start() - 3):m.start()].strip() == '']
    e = min(nxt) if nxt else None
    return re.sub(r'\s+', ' ', ' '.join(ln[v:e].strip() if e else ln[v:].strip() for ln in block)).strip()


def dual_layout(L):
    """Integrated dual-plan SBs: "Diagnostic radiology services (for example, X-rays or
    other imaging services, such as CAT scans or MRIs)" with the cost in a "Your costs" column."""
    for i, ln in enumerate(L):
        if not re.search(r'Diagnostic radiology', ln, re.I):
            continue
        if not re.search(r'\(for', ' '.join(L[i:i + 3])):
            continue
        block = L[i:i + 4]
        ev = ' '.join(x.strip() for x in block)
        m = re.search(r'Diagnostic radiology(?: services)?(?: \(for)?\s+(\$\s*[\d,]+|\d{1,3}\s*%)(?=\s{2,}|\s*$)', ln, re.I)
        if m:
            return amount(m.group(1), 'flat', ev)
        for b in block:
            for c, t in cells(b):
                if re.fullmatch(r'\$\s*[\d,]+(\s*copay)?|\d{1,3}\s*%(\s*coinsurance)?', t.strip(), re.I):
                    return amount(t, 'flat', ev)
    return None


# ---------------------------------------------------------------- carriers

def humana(L):
    for i, ln in enumerate(L):
        if not re.search(r'Advanced imaging services', ln, re.I):
            continue
        block = []
        for j in range(i, min(i + 16, len(L))):
            if j > i and re.search(r'Basic radiological|Diagnostic mammography|Diagnostic procedures', L[j], re.I):
                break
            block.append(L[j])
        for ln2 in block:
            m = re.search(r'Outpatient hospital:?\s*(.*)$', ln2, re.I)
            if m:
                first = (cells(m.group(1)) or [(0, '')])[0][1]
                r = amount(first, 'outpatient', ln2)
                if r:
                    return r
        if any(re.search(r'Freestanding|office|Outpatient hospital', b, re.I) for b in block):
            return res('none', evidence='per-setting list with no outpatient hospital amount: ' + ' / '.join(b.strip() for b in block[:6]))
        # flat: one value for the whole row
        txt = ' '.join(block)
        txt = re.sub(r'^.*?Advanced imaging services', '', txt, flags=re.I | re.S)
        first = value_column(block) or txt
        r = amount(first, 'flat', ' '.join(b.strip() for b in block[:4]))
        if r:
            return r
    r = dual_layout(L)
    if r:
        return r
    return res('none', evidence='no "Advanced imaging services" row')


def uhc(L):
    for i, ln in enumerate(L):
        if not re.search(r'MRI,?\s*CT', ln, re.I):
            continue
        lo = i
        while lo > 0 and i - lo < 4 and not re.search(r'Diagnostic\b', L[lo]):
            lo -= 1
        hi = i + 1
        while hi < len(L) and hi - i < 5 and not re.search(r'Lab services|Diagnostic tests\s|^\s*$', L[hi]):
            hi += 1
        block = L[lo:hi]
        txt = ' '.join(x.strip() for x in block)
        if not re.search(r'[$%]', txt):
            continue
        col = slice_column(block)
        m = re.search(r'(\$\s*[\d,]+(?:\.\d\d)?\s*copay|\d{1,3}\s*%\s*coinsurance)\s+otherwise', col, re.I)
        if m:
            return amount(m.group(1), 'otherwise', txt)
        if not re.search(r'mammogram', col, re.I):
            r = amount(col, 'flat', txt)
            if r:
                return r
        return res('none', evidence='row found, value not read: ' + txt)
    return res('none', evidence='no "MRI, CT" row')


def wellcare(L):
    T = '\n'.join(L)
    # "Your Summary of Benefits" layout
    for i, ln in enumerate(L):
        if not re.search(r'Diagnostic Radiology Services(?!\s*\(for)', ln, re.I):
            continue
        block = []
        for j in range(i, min(i + 14, len(L))):
            if j > i and re.search(r'Therapeutic Radiology|Out-of-Network|Outpatient X-?ray|Lab Services', L[j], re.I):
                break
            block.append(L[j])
        txt = re.sub(r'\s+', ' ', ' '.join(block))
        m = re.search(r'(\$\s*[\d,]+|\d{1,3}\s*%)\s*(?:copay|coinsurance)\s+for all other diagnostic radiology services(?:\s+received\s+in an outpatient hospital setting)?', txt, re.I)
        if m:
            basis = 'outpatient' if 'outpatient hospital' in m.group(0).lower() else 'otherwise'
            return amount(m.group(1), basis, txt)
        t2 = re.sub(r'(\$\s*[\d,]+|\d{1,3}\s*%)\s*(?:copay|coinsurance)\s+for a diagnostic mammogram\.?', '', txt, flags=re.I)
        t2 = re.sub(r'^.*?Diagnostic Radiology Services', '', t2, flags=re.I)
        r = amount(t2, 'flat', txt)
        if r:
            return r
    r = dual_layout(L)
    if r:
        return r
    return res('none', evidence='no diagnostic radiology row')


def aetna(L):
    for i, ln in enumerate(L):
        if not re.search(r'Diagnostic radiology', ln, re.I):
            continue
        block = []
        for j in range(i, min(i + 10, len(L))):
            if j > i and re.search(r'Outpatient x-?rays|Lab services|Hearing services', L[j], re.I):
                break
            block.append(L[j])
        txt = ' '.join(b.strip() for b in block)
        cs = cells(ln)
        val = None
        for c, t in cs:
            if re.search(r'[$%]', t):
                val = t
                break
        if val is None:
            # value sits on a wrapped line of the row
            v = value_column(block, min_col=20)
            val = v or None
        if val is None:
            continue
        if re.search(r'hospital facility', txt, re.I):
            m = re.search(r'(\$\s*[\d,]+|\d{1,3}\s*%)\s*(?:copay|coinsurance)\s+for services performed at a hospital facility', re.sub(r'\s+', ' ', txt), re.I)
            if m:
                return amount(m.group(1), 'outpatient', txt)
        r = amount(val, 'flat', txt)
        if r:
            return r
    return res('none', evidence='no diagnostic radiology row')


def devoted_dual(L):
    """D-SNP SBs with two columns, "With Medicaid cost share assistance" and "Without
    Medicaid cost share assistance". The plan's own cost share is the second one."""
    for h, ln in enumerate(L):
        m = re.search(r'Without Medicaid cost', ln)
        if not m or 'With Medicaid cost' not in ln:
            continue
        b = m.start() - 3
        col = []
        for x in L[h + 1:h + 70]:
            if re.search(r'With Medicaid cost', x):
                break
            col.append(x[b:].strip() if len(x) > b else '')
        txt = re.sub(r'\s+', ' ', ' '.join(col))
        m2 = re.search(r'Diagnostic Radiology \(such as[^)]*\)\s*(.*?)(?:Diagnostic Tests and|Radiation Therapy|$)', txt, re.I)
        if not m2:
            continue
        row = m2.group(1)
        m3 = re.search(r'Outpatient Hospital:\s*(.*)$', row, re.I)
        r = amount(m3.group(1) if m3 else row, 'outpatient-without-medicaid' if m3 else 'flat-without-medicaid', 'Without Medicaid cost share assistance: ' + row)
        if r:
            return r
    return None


def devoted(L):
    if any('Without Medicaid cost' in ln for ln in L):
        r = devoted_dual(L)
        return r or res('none', evidence='With/Without Medicaid layout, imaging row not read')
    for i, ln in enumerate(L):
        if not re.search(r'Diagnostic Radiology', ln, re.I):
            continue
        block = []
        for j in range(i, min(i + 12, len(L))):
            if j > i and re.search(r'Diagnostic Tests and|Radiation Therapy', L[j], re.I):
                break
            block.append(L[j])
        # first column only (some SBs print two plans side by side)
        first = ' '.join((cells(b) or [(0, '')])[0][1] for b in block)
        # when the row label sits left of the value on the heading line, drop it
        first = re.sub(r'^.*?Diagnostic Radiology', 'Diagnostic Radiology', first, flags=re.I)
        m = re.search(r'Outpatient Hospital:\s*(.*)$', first, re.I)
        if m:
            r = amount(m.group(1), 'outpatient', first)
            if r:
                return r
        t2 = re.sub(r'Diagnostic Radiology\s*\(such as[^)]*\)', '', first, flags=re.I)
        if not re.search(r'location', t2, re.I):
            r = amount(t2, 'flat', first)
            if r:
                return r
        return res('none', evidence='row found, value not read: ' + first)
    return res('none', evidence='no "Diagnostic Radiology" row')


def healthspring(L):
    for i, ln in enumerate(L):
        if not re.search(r'Diagnostic Radiology \(MRI', ln, re.I):
            continue
        block = []
        for j in range(i, min(i + 14, len(L))):
            if j > i and re.search(r'Therapeutic Radiology|X-ray Services', L[j], re.I):
                break
            block.append(L[j])
        txt = value_column(block, min_col=20)
        # a "$" split onto its own line by a narrow column: "0 copay for" + "$"
        txt = re.sub(r'(?<![\d$])(\d{1,4}) copay for \$', r'$\1 copay for', txt)
        txt = re.sub(r'\s+', ' ', txt)
        m = re.search(r'(\$\s*[\d,]+|\d{1,3}\s*%)\s*(?:copay|coinsurance)\s+for all other', txt, re.I)
        if m:
            return amount(m.group(1), 'otherwise', txt)
        t2 = re.sub(r'(\$\s*[\d,]+|\d{1,3}\s*%)\s*(?:copay|coinsurance)\s+for mammography[^.]*\.?', '', txt, flags=re.I)
        r = amount(t2, 'flat', txt)
        if r:
            return r
        return res('none', evidence='row found, value not read: ' + txt)
    return res('none', evidence='no "Diagnostic Radiology (MRIs" row')


CARRIER = {'Humana': humana, 'UnitedHealthcare': uhc, 'Wellcare': wellcare, 'Aetna Medicare': aetna,
           'Devoted Health': devoted, 'HealthSpring': healthspring}


def main():
    man = json.load(open(MANIFEST))
    only = None
    if '--only' in sys.argv:
        only = set(sys.argv[sys.argv.index('--only') + 1].split(','))
    out = {}
    for key, m in sorted(man.items()):
        if only and key not in only:
            continue
        p = os.path.join(SB, 'layout', key + '.txt')
        if not os.path.exists(p):
            continue
        L = clean(open(p, encoding='utf-8', errors='replace').read()).split('\n')
        r = CARRIER[m['carrier']](L)
        r['carrier'] = m['carrier']
        out[key] = r
    if only:
        print(json.dumps(out, indent=1))
        return
    json.dump(out, open(OUT, 'w'), indent=0, sort_keys=True)
    c = collections.Counter((v['carrier'], v['kind'], v['basis']) for v in out.values())
    for k, v in sorted(c.items(), key=lambda x: (x[0][0], -x[1])):
        print(f'{v:5d}  {k[0]:18s} {k[1]:6s} {k[2]}')
    print(len(out), 'SBs read ->', OUT)


if __name__ == '__main__':
    main()
