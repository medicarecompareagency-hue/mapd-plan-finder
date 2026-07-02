#!/usr/bin/env python3
"""
Humana Healthy Options wallet extractor (pdfplumber).
Reads a single PDF, finds the "Humana Healthy Options" section,
and extracts the monthly allowance amount + gating classification.

Usage: python scripts/extract-humana-healthy-options.py <pdf_path>
Output: JSON to stdout (ensure_ascii=True so no encoding issues)

Gating:
  all_members       -- no condition qualifier found
  ssbci_conditional -- "specific health conditions" / standard SSBCI language
  deep_gated        -- specific disease names or "must qualify/enroll/call"
                       (report but do NOT write sbVerifiedFoodAmount)
"""
import sys
import json
import re

try:
    import pdfplumber
except ImportError:
    print(json.dumps({"found": False, "error": "pdfplumber not installed"}))
    sys.exit(1)

SECTION_RE = re.compile(r"humana\s*healthy\s*options", re.IGNORECASE)

# "$105 monthly allowance", "$60 per month", "$130 allowance per month"
MONTHLY_RE = re.compile(
    r"\$\s*(\d[\d,]*)"
    r"(?:\s+\w+){0,5}?"
    r"\s+(?:monthly\s+allowance|per\s+month|/\s*month|a\s+month|each\s+month|allowance\s+per\s+month)",
    re.IGNORECASE,
)
# Fallback: "$105 allowance on a prepaid spending card"
SPENDING_CARD_RE = re.compile(
    r"\$\s*(\d[\d,]*)\s+(?:\w+\s+){0,6}(?:spending\s+card|prepaid\s+card|prepaid\s+spending)",
    re.IGNORECASE,
)

FOOD_MARKER_RE = re.compile(
    r"grocer(?:y|ies)|eligible\s+food|\bfood\b|utilities|meals|rent|mortgage",
    re.IGNORECASE,
)

SSBCI_RE = re.compile(
    r"specific\s+health\s+conditions|chronically\s+ill|special\s+supplemental\s+benefit",
    re.IGNORECASE,
)
DEEP_GATE_RE = re.compile(
    r"must\s+(?:qualify|call|enroll|contact)|"
    r"call\s+(?:to|us|your)\b|"
    r"congestive\s+heart\s+failure|diabetes\s+mellitus|"
    r"heart\s+failure|hypertension|chronic\s+kidney|"
    r"you\s+may\s+qualify\s+if",
    re.IGNORECASE,
)


def classify_gating(ctx: str) -> str:
    if DEEP_GATE_RE.search(ctx):
        return "deep_gated"
    if SSBCI_RE.search(ctx):
        return "ssbci_conditional"
    return "all_members"


def covers_list(ctx: str) -> list:
    cl = ctx.lower()
    out = []
    if re.search(r"grocer|eligible\s+food|\bfood\b", cl):
        out.append("food/groceries")
    if "utilit" in cl:
        out.append("utilities")
    if "rent" in cl or "mortgage" in cl or "housing" in cl:
        out.append("housing")
    if "meal" in cl:
        out.append("meals")
    if "otc" in cl or "over-the-counter" in cl:
        out.append("otc")
    return out


def extract(pdf_path: str) -> dict:
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for pn, page in enumerate(pdf.pages[:50], 1):
                text = page.extract_text() or ""

                # Also check table cells for the section header
                for table in page.extract_tables():
                    for row in table:
                        cell = " ".join(str(c or "").strip() for c in row if c)
                        if SECTION_RE.search(cell):
                            text += "\n" + cell

                if not SECTION_RE.search(text):
                    continue

                lines = text.split("\n")
                for i, line in enumerate(lines):
                    if not SECTION_RE.search(line):
                        continue

                    # Context: up to 20 lines after the header
                    ctx_lines = lines[i : i + 20]
                    ctx = " ".join(ctx_lines)

                    # Primary: "$X monthly allowance" or "$X per month"
                    m = MONTHLY_RE.search(ctx)
                    if not m:
                        # Secondary: "$X ... spending/prepaid card" with food context
                        m2 = SPENDING_CARD_RE.search(ctx)
                        if m2 and FOOD_MARKER_RE.search(ctx):
                            m = m2

                    if m:
                        monthly = int(m.group(1).replace(",", ""))
                        if monthly == 0:
                            # $0 is not a wallet; keep scanning
                            continue

                        annual = monthly * 12
                        gating = classify_gating(ctx)
                        snippet = ctx[:350].replace("\n", " ").strip()

                        return {
                            "found": True,
                            "monthly": monthly,
                            "annual": annual,
                            "period": "month",
                            "gating": gating,
                            "covers": covers_list(ctx),
                            "page": pn,
                            "snippet": snippet,
                        }

                    else:
                        # Section header found but no dollar amount extracted
                        dollars = re.findall(r"\$\s*\d[\d,]*", ctx[:400])
                        return {
                            "found": True,
                            "monthly": None,
                            "annual": None,
                            "period": None,
                            "gating": classify_gating(ctx),
                            "covers": covers_list(ctx),
                            "page": pn,
                            "snippet": ctx[:300].replace("\n", " ").strip(),
                            "dollars_nearby": dollars[:6],
                        }

        return {
            "found": False,
            "monthly": None,
            "annual": None,
            "error": "Humana Healthy Options section not found in first 50 pages",
        }

    except Exception as e:
        return {
            "found": False,
            "monthly": None,
            "annual": None,
            "error": str(e),
        }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"found": False, "error": "Usage: python extract-humana-healthy-options.py <pdf_path>"}))
        sys.exit(1)
    result = extract(sys.argv[1])
    print(json.dumps(result, ensure_ascii=True))
