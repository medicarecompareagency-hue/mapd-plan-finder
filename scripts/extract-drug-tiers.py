#!/usr/bin/env python3
"""
Extract Tier 1-6 Part D drug cost-sharing from DSNP Summary-of-Benefits PDFs.

Why a separate Python script (not extract-sb-benefits.ts):
  extract-sb-benefits.ts uses pdf-parse, which collapses the SB drug-tier
  GRID into ragged single-value lines and loses row/column structure.
  pdfplumber preserves the table rows, so tier parsing is reliable here.

Convention (matches scripts/import-cms-data.ts PBP import, field
mrx_tier_rstd_copay_1m): drugTierNCopay stores the RETAIL STANDARD 30-day
value. Flat copays stored as dollars; coinsurance stored as the bare percent
number, with the tier number recorded in drugTierCoinsuranceMask.

Resumable: reloads OUT and skips files already processed, flushing
periodically so a chunked/interrupted run loses nothing.

Input : sb-dsnp-discovery-results.json  (file + planIds per PDF)
Output: sb-dsnp-tier-extraction.json    (per PDF: tiers + mask + meta)

Usage: python3 scripts/extract-drug-tiers.py [discovery.json] [out.json]
"""
import json
import os
import re
import sys

import pdfplumber

DISCOVERY = sys.argv[1] if len(sys.argv) > 1 else "sb-dsnp-discovery-results.json"
OUT = sys.argv[2] if len(sys.argv) > 2 else "sb-dsnp-tier-extraction.json"
TARGET_YEAR = 2026

MONEY = re.compile(r"\$\s?([0-9][0-9,]*(?:\.\d{2})?)")
PCT = re.compile(r"(\d{1,3})\s?%")
TIER_LINE = re.compile(r"\bTier\s+([1-6])\s*:", re.I)  # colon req: table rows have it, prose mentions do not

# Patterns whose presence in the first ~4000 chars means the document is not
# a Summary of Benefits. Ordered most-specific first; first match wins.
_WRONG_DOC_PATTERNS = [
    (r"do\s+not\s+return\s+this\s+form\s+to\s+cms", "enrollment-form"),
    (r"i\s+want\s+to\s+enroll", "enrollment-form"),
    (r"enrollment\s+application", "enrollment-form"),
    (r"social\s+security\s+number", "enrollment-form"),
    (r"frequently\s+asked\s+questions", "faq"),
    (r"quick\s+reference\s+guide", "reference-guide"),
    (r"\bqrg\b", "reference-guide"),
    (r"provider\s+directory", "provider-directory"),
    (r"participating\s+provider", "provider-directory"),
    (r"annual\s+notice\s+of\s+change", "anoc"),
    (r"\banoc\b", "anoc"),
    (r"evidence\s+of\s+coverage", "eoc"),
]


def detect_doc_type(text):
    """Return a doc-type tag for the first 4000 chars of extracted text.

    Returns "sb" when 'Summary of Benefits' appears in the title area,
    a specific wrong-type label when a disqualifying pattern is found,
    or "unknown" when neither signal is present (caller should proceed
    normally rather than rejecting on uncertainty alone).
    """
    head = text[:4000].lower()
    for pattern, kind in _WRONG_DOC_PATTERNS:
        if re.search(pattern, head):
            return kind
    if re.search(r"summary\s+of\s+benefits", head):
        return "sb"
    return "unknown"


def carrier_of(path):
    p = path.lower()
    if "humana" in p:
        return "humana"
    if "devoted" in p:
        return "devoted"
    if "aetna" in p:
        return "aetna"
    if "unitedhealthcare" in p or "uhc" in p:
        return "uhc"
    return "unknown"


def first_value(segment):
    """Return (number, kind) for the first $ or % token in `segment`.
    kind is 'copay' or 'coins'. Percent wins only if it precedes the money."""
    m = MONEY.search(segment)
    p = PCT.search(segment)
    if m and (not p or m.start() <= p.start()):
        return float(m.group(1).replace(",", "")), "copay"
    if p:
        return float(p.group(1)), "coins"
    return None, None


def parse_tiers(lines):
    """Return {tier_int: (value, kind)} for the drug cost-sharing table.

    Two SB layouts exist and are auto-detected per PDF:
      * inline grid (Humana/Aetna): value sits on the "Tier N:" row itself,
        or wraps to the next 1-3 lines.
      * value-before-name (Devoted): the cost line precedes the "Tier N:"
        name line. Here we must NOT look forward, or we steal the next
        tier's preceding-value line.
    Either way we take the first token = retail standard 30-day column.
    """
    idxs = []  # (line_index, tier_int, label_end)
    for i, ln in enumerate(lines):
        m = TIER_LINE.search(ln)
        if m:
            idxs.append((i, int(m.group(1)), m.end()))
    if not idxs:
        return {}

    tier_lines = {i for (i, _t, _e) in idxs}
    inline_hits = sum(1 for (i, _t, e) in idxs if first_value(lines[i][e:])[0] is not None)
    before_mode = inline_hits < 2

    tiers = {}
    for (i, tier, end) in idxs:
        if tier in tiers:  # first table occurrence wins
            continue
        val = kind = None
        if not before_mode:
            val, kind = first_value(lines[i][end:])
            if val is None:  # wrapped row: scan forward, stop at next tier
                for j in range(i + 1, min(i + 4, len(lines))):
                    if j in tier_lines:
                        break
                    val, kind = first_value(lines[j])
                    if val is not None:
                        break
        else:  # value-before-name: only the preceding non-empty line
            for j in range(i - 1, max(i - 4, -1), -1):
                if not lines[j].strip():
                    continue
                if j in tier_lines:
                    break
                val, kind = first_value(lines[j])
                break
        if val is not None:
            tiers[tier] = (val, kind)
    return tiers


_PROSE_ANCHOR = re.compile(r"\$\s*(\d+)\s+(?:copay\s+)?for\s+(?:a\s+)?Tier\s+([1-6])", re.I)
_PROSE_TIER_NUM = re.compile(r"\bTier\s+([1-6])\b(?!\s*:)", re.I)


def parse_prose_tier_list(text):
    """Handle Humana-style '$0 for a Tier 1, Tier 2 or Tier 6' prose.

    Some FIDE-SNP layouts express shared-cost tiers in a single prose phrase
    rather than individual table rows.  PDF column interleaving scatters the
    tier numbers onto separate lines, so we flatten newlines and scan a short
    window after the anchor for additional Tier N mentions.

    Returns {tier_int: (value, 'copay')} with every tier that shares the
    stated amount, or {} if the pattern is not found.
    """
    flat = text.replace("\n", " ")
    m = _PROSE_ANCHOR.search(flat)
    if not m:
        return {}
    val = float(m.group(1).replace(",", ""))
    # Seed with the tier captured by the anchor ("$X for a Tier N"), then
    # scan a short forward window for additional "Tier N" mentions (no colon
    # means prose reference, not a table label).  Window is intentionally
    # tight (200 chars) to avoid false positives from later table labels.
    tiers = {int(m.group(2)): (val, "copay")}
    window = flat[m.start(2):m.start(2) + 200]
    for hit in _PROSE_TIER_NUM.finditer(window):
        tiers[int(hit.group(1))] = (val, "copay")
    return tiers


def detect_year(text):
    head = text[:9000]
    yrs = set()
    for m in re.finditer(r"\b(20(?:2[3-9]|3\d))\s+(?:Medicare\s+)?Summary\s+of\s+Benefits", head, re.I):
        yrs.add(int(m.group(1)))
    for m in re.finditer(r"Summary\s+of\s+Benefits\s+(?:for\s+)?(20(?:2[3-9]|3\d))", head, re.I):
        yrs.add(int(m.group(1)))
    return yrs


def main():
    disc = json.load(open(DISCOVERY))
    try:
        results = json.load(open(OUT))
    except Exception:
        results = []
    done = {r["file"] for r in results}
    skipped_year = sum(1 for r in results if r["status"].startswith("skip-stale"))
    no_tiers = sum(1 for r in results if r["status"] == "no-tier-table")
    start_count = len(results)

    def maybe_flush():
        if (len(results) - start_count) % 8 == 0:
            json.dump(results, open(OUT, "w"), indent=2)
            print(f"...{len(results)} total ({len(results) - start_count} new)", flush=True)

    for item in disc:
        base = os.path.basename(item["file"].replace("\\", "/"))
        if base in done:
            continue
        rel = item["file"].replace("\\", "/")
        path = rel if os.path.exists(rel) else os.path.join("summary-of-benefits-dsnp", base)
        if not os.path.exists(path):
            path = os.path.join("summary-of-benefits", base)
        rec = {
            "file": base,
            "planIds": item.get("planIds", []),
            "carrier": carrier_of(rel),
            "tiers": {},
            "coinsuranceMask": "",
            "flatZero": False,
            "year": None,
            "status": "",
        }
        try:
            with pdfplumber.open(path) as pdf:
                text = "\n".join((pg.extract_text() or "") for pg in pdf.pages)
        except Exception as e:
            rec["status"] = f"pdf-error: {e}"
            results.append(rec)
            maybe_flush()
            continue
        lines = text.split("\n")

        # Document-type guard: reject non-SB documents (provider FAQs,
        # enrollment forms, etc.) before they consume year/tier logic.
        doc_type = detect_doc_type(text)
        rec["docType"] = doc_type
        if doc_type not in ("sb", "unknown"):
            rec["status"] = f"wrong-doc-type:{doc_type}"
            results.append(rec)
            maybe_flush()
            continue

        # Year guard: skip stale PDFs that would write old data tagged 2026.
        yrs = detect_year(text)
        rec["year"] = sorted(yrs) if yrs else None
        if yrs and TARGET_YEAR not in yrs:
            rec["status"] = f"skip-stale-year:{sorted(yrs)}"
            skipped_year += 1
            results.append(rec)
            maybe_flush()
            continue

        tiers = parse_tiers(lines)

        # UHC-style flat: "All covered drugs $X copay" with no tier grid.
        if not tiers:
            flat = (re.search(r"[Aa]ll covered drugs?\d?\s*\$(\d+)\s*copay", text)
                    or re.search(r"[Aa]ll covered\s+\$(\d+)\s*copay", text))
            if flat:
                v = float(flat.group(1))
                for t in range(1, 7):
                    tiers[t] = (v, "copay")
                rec["flatZero"] = (v == 0)

        # Humana FIDE-SNP style: "$0 for a Tier 1, Tier 2 or Tier 6" prose
        # where a multi-column table collapses and loses per-row values.
        if not tiers:
            tiers = parse_prose_tier_list(text)

        # Sanity: drop values too large to be a tier copay (MOOP / deductible /
        # catastrophic threshold leaked from a multi-column narrative layout),
        # and reject records with too few tiers to be a trustworthy table.
        tiers = {t: vk for t, vk in tiers.items() if vk[0] <= 600}
        if len(tiers) < 3:
            tiers = {}

        if not tiers:
            rec["status"] = "no-tier-table"
            no_tiers += 1
            results.append(rec)
            maybe_flush()
            continue

        mask = ""
        out_tiers = {}
        for t in range(1, 7):
            if t in tiers:
                val, kind = tiers[t]
                out_tiers[f"drugTier{t}Copay"] = val
                if kind == "coins":
                    mask += str(t)
            else:
                out_tiers[f"drugTier{t}Copay"] = None
        rec["tiers"] = out_tiers
        rec["coinsuranceMask"] = mask
        rec["status"] = "ok"
        results.append(rec)
        maybe_flush()

    json.dump(results, open(OUT, "w"), indent=2)
    ok = sum(1 for r in results if r["status"] == "ok")
    errs = sum(1 for r in results if r["status"].startswith("pdf-error"))
    wrong_doc = sum(1 for r in results if r["status"].startswith("wrong-doc-type"))
    print(f"PDFs processed: {len(results)}")
    print(f"  ok (tiers extracted): {ok}")
    print(f"  skipped stale-year:   {skipped_year}")
    print(f"  no tier table:        {no_tiers}")
    print(f"  wrong doc type:       {wrong_doc}")
    print(f"  pdf errors:           {errs}")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
