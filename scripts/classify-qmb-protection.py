#!/usr/bin/env python3
# Classify whether a FULL_DUAL DSNP plan protects standalone QMB at $0 (=> show for QMB)
# vs is QMB+-only (=> hide for QMB). Source of truth: each plan's Summary of Benefits PDF.
import pdfplumber, re, glob, os, json, argparse, sys

def _norm(s):
    # strip soft-hyphen (U+00AD) and non-breaking space (U+00A0); copy-safe escapes
    s = s.replace("­", "").replace(" ", " ")
    # normalize all Unicode hyphens/dashes/minus to ASCII "-"
    for d in ["‐", "‑", "‒", "–", "—", "―", "−"]:
        s = s.replace(d, "-")
    return s

LEVEL_CANON = {
    "qmb+": "QMB+", "qmb plus": "QMB+", "qmb-plus": "QMB+", "qmbplus": "QMB+",
    "qualified medicare beneficiary plus": "QMB+",
    "slmb+": "SLMB+", "slmb plus": "SLMB+", "slmb-plus": "SLMB+",
    "specified low-income medicare beneficiary plus": "SLMB+",
    "fbde": "FBDE", "full benefit dual eligible": "FBDE",
    "full benefits dual eligible": "FBDE", "full-benefit dual eligible": "FBDE",
    "qmb": "QMB", "qualified medicare beneficiary": "QMB",
    "slmb": "SLMB", "specified low-income medicare beneficiary": "SLMB",
    "qi": "QI", "qi-1": "QI", "qi1": "QI", "qualifying individual": "QI",
}
ORDERED = sorted(LEVEL_CANON.items(), key=lambda kv: -len(kv[0]))

def levels_in(text):
    """Canonical Medicaid levels named in a short span. Consumes '+'-variants first
    so a bare QMB/SLMB is never read out of a QMB+/SLMB+ token."""
    t = " " + re.sub(r"\s+", " ", _norm(text).lower()) + " "
    found, work = set(), t
    for k, v in ORDERED:
        if v in ("QMB+", "SLMB+"):
            pat = re.escape(k)
            if re.search(pat, work):
                found.add(v); work = re.sub(pat, " ", work)
    for k, v in ORDERED:
        if v in ("QMB+", "SLMB+"):
            continue
        pat = r"(?<![a-z+])" + re.escape(k) + r"(?![a-z+])"
        if re.search(pat, work):
            found.add(v)
    return found

def classify(full):
    low = re.sub(r"\s+", " ", _norm(full)).lower()
    # Rule 1: explicit cost-share-protected list
    m = re.search(r"cost[- ]?share protected[:\s]+([a-z0-9 ,+\-/&]+?)(?:\.|\bin-network\b|\bn/a\b|$)", low)
    if m:
        lv = levels_in(m.group(1))
        if lv:
            return ("QMB" in lv, sorted(lv), "rule1:protected-list")
    # Rule 2: full-Medicaid conditional => QMB-only pays
    if re.search(r"if you have full medicaid", low) and re.search(r"otherwise,? you will pay", low):
        return (False, [], "rule2:full-medicaid-conditional")
    # Rule 3: eligibility / group-include list
    for anchor in [
        r"you can enroll in this plan if you are in one of these medicaid categories[:\s]+(.{0,400})",
        r"benefits available to ([a-z0-9 ,+\-/&]+?)(?:\.|benefit category|$)",
        r"the people in this group include[:\s]+(.{0,200})",
        r"this plan may enroll ([a-z0-9 ,+\-/&]+?)\.",
    ]:
        m = re.search(anchor, low)
        if m:
            lv = levels_in(m.group(1))
            if lv:
                return ("QMB" in lv, sorted(lv), "rule3:eligibility-list")
    # rule4 (Wellcare): "you must be eligible for the following medicare savings program:
    #   <contract+name> (XXX d-snp) - <levels> refer to "medicare savings program (msp) levels""
    m = re.search(r"following medicare savings program[:\s].{0,160}?d-snp\)\s*-\s*([a-z0-9 ,+]+?)\s*(?:refer to|\.|please contact)", low)
    if m:
        lv = levels_in(m.group(1))
        if lv:
            return ("QMB" in lv, sorted(lv), "rule4:wellcare-msp-list")
    # rule5 (Devoted): "...full medicaid benefits or are a qualified medicare beneficiary
    #   (fbde, slmb+, qmb+, qmb), you may pay $0 for your medicare-covered services"
    m = re.search(r"full medicaid benefits or are a qualified medicare beneficiary \(([a-z0-9 ,+]+)\),? you (?:may )?pay \$0", low)
    if m:
        lv = levels_in(m.group(1))
        if lv:
            return ("QMB" in lv, sorted(lv), "rule5:devoted-zero-list")
    # rule6 (Aetna 2026 table): "eligibility category | what it covers" table names exactly
    # the categories that may enroll; standalone "(qmb)" row = QMB eligible.
    m = re.search(r"eligibility categor(?:y|ies)\.? what it covers(.{0,900})", low)
    if m:
        span = m.group(1)
        lv = set()
        if re.search(r"\(qmb\)", span): lv.add("QMB")
        if re.search(r"\(qmb plus\)|\(qmb\+\)", span): lv.add("QMB+")
        if re.search(r"\(slmb plus\)|\(slmb\+\)", span): lv.add("SLMB+")
        if re.search(r"\(slmb\)", span): lv.add("SLMB")
        if re.search(r"\(fbde\)", span): lv.add("FBDE")
        if lv:
            return ("QMB" in lv, sorted(lv), "rule6:aetna-elig-table")
    return (None, [], "uncertain")

def extract_columns(f, cap=20):
    """De-interleave two-column layouts: left half then right half per page.
    Cigna/HealthSpring + Aetna SBs interleave two columns, which breaks the
    rule3 anchors on plain extraction."""
    parts = []
    with pdfplumber.open(f) as pdf:
        for pg in pdf.pages[:cap]:
            w, h = pg.width, pg.height
            for box in [(0, 0, w/2, h), (w/2, 0, w, h)]:
                try:
                    parts.append(pg.crop(box).extract_text() or "")
                except Exception:
                    pass
    return "\n".join(parts)

def planid_from_name(fn):
    # DB stores planIds without zero-padding (H2802-64, not H2802-064).
    m = re.search(r"H(\d{4})[_-](\d{1,3})", fn)
    return f"H{m.group(1)}-{int(m.group(2))}" if m else None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sbdir", required=True, help="dir of sb-2026-*.pdf files")
    ap.add_argument("--out", default="scripts/data/qmb-protection.json")
    args = ap.parse_args()
    files = sorted(glob.glob(os.path.join(args.sbdir, "sb-2026-*.pdf")))
    if not files:
        print(f"!! no SB PDFs under {args.sbdir}", file=sys.stderr); sys.exit(2)
    out = {}
    for f in files:
        pid = planid_from_name(os.path.basename(f))
        if not pid:
            continue
        try:
            with pdfplumber.open(f) as pdf:
                full = "\n".join((pg.extract_text() or "") for pg in pdf.pages)
        except Exception as e:
            print(f"  ERR {pid}: {e}", file=sys.stderr); continue
        prot, lv, sig = classify(full)
        if prot is None:
            # two-column retry: plain extraction interleaves columns on some carriers
            try:
                prot, lv, sig = classify(extract_columns(f))
            except Exception as e:
                print(f"  ERR {pid} (column retry): {e}", file=sys.stderr)
        # keep the most-confident answer if a planId appears across multiple county PDFs
        prev = out.get(pid)
        if prev is None or (prev["protected"] is None and prot is not None):
            out[pid] = {"protected": prot, "levels": lv, "signal": sig}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump(out, open(args.out, "w"), indent=2)

    t = sum(1 for v in out.values() if v["protected"] is True)
    f = sum(1 for v in out.values() if v["protected"] is False)
    n = sum(1 for v in out.values() if v["protected"] is None)
    print(f"\nclassified {len(out)} planIds -> protected(show)={t}  qmbplus(hide)={f}  uncertain={n}")
    print(f"written: {args.out}")

    # Regression asserts (validated against the real carrier SBs)
    # planIds use DB format: no zero-padding (H2802-64 not H2802-064)
    EXPECT = {"H2802-64": False, "H3239-26": False, "H5216-164": True}
    bad = []
    for pid, exp in EXPECT.items():
        got = out.get(pid, {}).get("protected", "MISSING")
        ok = (got == exp)
        print(f"  assert {pid}: got={got} expect={exp} {'OK' if ok else '<<< MISMATCH'}")
        if not ok and got != "MISSING":
            bad.append(pid)
    if bad:
        print(f"!! classifier regressed on {bad} — fix before applying", file=sys.stderr); sys.exit(1)

if __name__ == "__main__":
    main()
