# save as scripts/sample-uhc-drug-text.py
import pdfplumber
import os
import json

DISCOVERY = "sb-dsnp-discovery-results.json"
EXTRACTION = "sb-dsnp-tier-extraction.json"

# Find UHC files that came back no-tier-table
with open(EXTRACTION) as f:
    results = json.load(f)

no_tier_uhc = [
    r["file"] for r in results
    if r["status"] == "no-tier-table" and r["carrier"] == "uhc"
][:5]  # just the first 5

print(f"Sampling {len(no_tier_uhc)} UHC no-tier-table PDFs\n")

for filename in no_tier_uhc:
    path = os.path.join("summary-of-benefits-dsnp", filename)
    if not os.path.exists(path):
        path = os.path.join("summary-of-benefits", filename)
    if not os.path.exists(path):
        print(f"NOT FOUND: {filename}\n")
        continue

    with pdfplumber.open(path) as pdf:
        text = "\n".join(pg.extract_text() or "" for pg in pdf.pages)

    # Find the drug cost section
    idx = text.lower().find("drug")
    snippet = text[max(0, idx - 100): idx + 1500]

    print(f"=== {filename} ===")
    print(snippet)
    print()