#!/usr/bin/env python
"""
scripts/extract-mri-outpatient.py

Reads scripts/data/mri-worklist-with-urls-2026-07.json (produced by
scripts/_export-mri-worklist-urls.js) and, for every worklist plan, downloads
its 2026 SB PDF (cached under .cms-import-tmp/sb-mri-cache/) and extracts the
"Outpatient hospital" advanced-imaging copay per Dale's outpatient-hospital
rule (2026-07-06):

  When an SB lists advanced-imaging copays by place of service (freestanding
  facility / outpatient hospital / PCP office / specialist office), always use
  the OUTPATIENT HOSPITAL amount for mriCopay/catScanCopay.

If the SB shows one flat copay for advanced imaging (no per-setting split),
that flat value is the truth. Anything ambiguous (coinsurance-only, no
extractable text, block not found) goes on a SKIPPED list -- no guessing.

Usage:
  python scripts/extract-mri-outpatient.py [--limit N] [--only planId,planId,...]

Writes (incrementally, resumable):
  .cms-import-tmp/sb-mri-cache/mri-checkpoint.jsonl   -- one JSON line per processed planId
Final aggregation (run again with --finalize, or automatically at the end of a full run):
  scripts/data/mri-outpatient-fixes-2026-07.json
"""
import json
import os
import re
import sys
import time
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

import requests
import pdfplumber

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKLIST_PATH = os.path.join(ROOT, "scripts", "data", "mri-worklist-with-urls-2026-07.json")
CACHE_DIR = os.path.join(ROOT, ".cms-import-tmp", "sb-mri-cache")
CHECKPOINT_PATH = os.path.join(CACHE_DIR, "mri-checkpoint.jsonl")
OUT_PATH = os.path.join(ROOT, "scripts", "data", "mri-outpatient-fixes-2026-07.json")
ANCHOR_PLAN_ID = "H1036-329"
ANCHOR_EXPECTED = 335.0

os.makedirs(CACHE_DIR, exist_ok=True)

HEADING_RE = re.compile(
    r"(advanced imaging services|advanced imaging|diagnostic radiology(?! service area)|"
    r"mri,?\s*(mra,?\s*)?(pet)?.{0,20}ct(?:/cat)? scan)",
    re.IGNORECASE,
)
OUTPATIENT_RE = re.compile(r"outpatient hospital|hospital outpatient|hospital \(outpatient\)", re.IGNORECASE)
PLACE_KEYWORDS_RE = re.compile(
    r"freestanding|\boffice\b|\bpcp\b|specialist|non-hospital|facility location", re.IGNORECASE
)
DOLLAR_RE = re.compile(r"\$\s*([\d,]+(?:\.\d{1,2})?)")
PERCENT_RE = re.compile(r"(\d{1,3})\s*%")
BULLET_CHARS = ("•", "-", "*", "�", "·")
MRI_CT_OTHERWISE_RE = re.compile(
    # Same-line only (exclude \n) and "otherwise" mandatory -- a looser version
    # of this pattern was matching across unrelated lines in jumbled
    # multi-column UHC pages, grabbing an unrelated category's $ value.
    r"MRI,?\s*CT\b[^$\n]{0,60}\$\s*([\d,]+(?:\.\d{1,2})?)\s*copay\s+otherwise", re.IGNORECASE
)
EOC_RE = re.compile(r"evidence of coverage", re.IGNORECASE)
SB_RE = re.compile(r"summary of benefits", re.IGNORECASE)
MAMMOGRAM_RE = re.compile(r"mammogram", re.IGNORECASE)
OTHER_RE = re.compile(r"\bother(wise)?\b", re.IGNORECASE)

write_lock = Lock()


def num(s):
    try:
        return float(s.replace(",", ""))
    except Exception:
        return None


def is_bullet_line(line):
    line = line.strip()
    return bool(line) and line[0] in BULLET_CHARS


def _ok(new_mri, source, evidence):
    return {"status": "ok", "newMri": new_mri, "source": source, "evidence": evidence}


def _skip(reason, evidence):
    return {"status": "skip", "reason": reason, "evidence": evidence}


DANGLING_DASH_RE = re.compile(r"[-–—]\s*$")


def _classify(cand):
    """Classify a candidate string that should carry the outpatient-hospital
    (or flat) value. Returns (kind, value) where kind in
    {"single", "range", "coins", "none"}.
    """
    dollars = DOLLAR_RE.findall(cand)
    if len(dollars) >= 2:
        return "range", None
    if len(dollars) == 1:
        if DANGLING_DASH_RE.search(cand.strip()):
            # a lone $ followed by a trailing dash usually means the range's
            # second half got cut off (e.g. by a jumbled multi-column layout) --
            # treat as an unresolved range rather than trusting the single value.
            return "range", None
        return "single", num(dollars[0])
    if PERCENT_RE.search(cand):
        return "coins", None
    return "none", None


def try_mammogram_otherwise(lines, idx):
    """A line showing "$0 copay for a diagnostic mammogram" is a carve-out
    exception, not the general imaging copay. Look at the next 1-2 lines for
    an explicit "other/otherwise" value; if found, that is the real flat
    value. If a $ appears without "other" wording first, or nothing resolves,
    return None so the caller skips conservatively rather than guessing.
    """
    for look in range(idx + 1, min(idx + 3, len(lines))):
        nxt = lines[look].strip()
        if not nxt:
            break
        if OTHER_RE.search(nxt):
            nkind, nval = _classify(nxt)
            if nkind == "single":
                return _ok(nval, "sb-flat-otherwise", nxt)
            if nkind == "range":
                return _skip("mammogram carve-out found but the following 'other' line shows a range", nxt)
        if "$" in nxt:
            break
    return None


def looks_duplicated(line):
    """Detects the telltale sign of a jumbled two-column PDF extraction: the
    same phrase appearing twice back-to-back on one physical line (e.g.
    "Office or freestanding Office or freestanding"). When this shows up
    nearby, any single value we'd otherwise accept may actually belong to a
    different column -- safer to bail out than guess which one.
    """
    words = line.split()
    n = len(words)
    if n < 4 or n % 2 != 0:
        return False
    half = n // 2
    return words[:half] == words[half:]


def scan_window(lines, start_idx, max_window=45):
    """Scan a window of lines after a heading for the outpatient-hospital
    line (handles both same-line values like Devoted's "Outpatient hospital:
    $200 - $300 copay" and bullet-per-line values like Humana's). Also tracks
    whether any OTHER place-of-service keyword appears, and collects the
    non-mammogram flat value if the section turns out to have no per-setting
    split at all (e.g. UnitedHealthcare's single "$260 copay otherwise" row).
    Returns a result dict, or None if nothing conclusive found in the window.
    """
    end = min(len(lines), start_idx + max_window)
    for idx in range(start_idx, min(end, start_idx + 8)):
        probe = lines[idx].strip()
        if not probe:
            break
        if looks_duplicated(probe):
            return _skip("jumbled multi-column layout detected near heading (duplicate label text) -- cannot reliably parse", probe)
    saw_place_keyword = False
    flat_candidate = None  # first single $ value seen with no place keyword yet
    for idx in range(start_idx, end):
        line = lines[idx].strip()
        if not line:
            break
        if PLACE_KEYWORDS_RE.search(line):
            saw_place_keyword = True
        candidates = [line]
        nxt = lines[idx + 1].strip() if idx + 1 < end else ""
        # Only merge forward when this line has no $ of its own -- i.e. it's a
        # bare wrapped label whose value lives on the next line. If this line
        # already carries a $ value, treat it as complete and self-contained
        # (merging would wrongly pull in the *next* line's separate value).
        if nxt and not is_bullet_line(nxt) and "$" not in line:
            candidates.append(line + " " + nxt)
        for cand in candidates:
            if OUTPATIENT_RE.search(cand):
                kind, val = _classify(cand)
                if kind == "single":
                    return _ok(val, "sb-outpatient", cand)
                if kind == "range":
                    return _skip("outpatient hospital line itself shows a range, ambiguous single value", cand)
                if kind == "coins":
                    return _skip("outpatient hospital line shows coinsurance not copay", cand)
                return _skip("outpatient hospital line found but no $ amount parsed", cand)
        if flat_candidate is None and not saw_place_keyword:
            kind, val = _classify(line)
            if kind == "single":
                if MAMMOGRAM_RE.search(line) and not OTHER_RE.search(line):
                    res = try_mammogram_otherwise(lines, idx)
                    if res is not None:
                        return res
                    # unresolved mammogram carve-out -- don't treat $0 as the real value
                else:
                    flat_candidate = (val, line)
            elif kind == "range":
                flat_candidate = ("range", line)
    if saw_place_keyword:
        return _skip("per-setting breakdown found but no outpatient hospital line", None)
    if flat_candidate is not None:
        if flat_candidate[0] == "range":
            return _skip("flat value is a range with no place-of-service breakdown", flat_candidate[1])
        return _ok(flat_candidate[0], "sb-flat", flat_candidate[1])
    return None


def parse_pdf_text(full_text):
    """Given full extracted PDF text (all pages joined with \\n), find the advanced
    imaging heading and pick the outpatient-hospital (or flat) copay.
    Returns dict with keys: status, newMri, source, evidence, reason
    """
    lines = full_text.split("\n")

    for i, line in enumerate(lines):
        if not HEADING_RE.search(line):
            continue

        if looks_duplicated(line):
            return _skip("jumbled multi-column layout detected at heading line (duplicate label text) -- cannot reliably parse", line.strip())

        # Single-row table style: label and value(s) share one line, e.g.
        # "Diagnostic Radiology (MRIs, CT scans, etc.) $0-$235 copay" or
        # "Diagnostic radiology $150 copay 50% coinsurance" (Aetna).
        kind, val = _classify(line)
        heading_has_place_keyword = PLACE_KEYWORDS_RE.search(line)
        if kind == "range" and not heading_has_place_keyword:
            return _skip("heading line shows a range with no place-of-service breakdown", line.strip())
        if kind == "single" and not heading_has_place_keyword:
            if MAMMOGRAM_RE.search(line) and not OTHER_RE.search(line):
                res = try_mammogram_otherwise(lines, i)
                if res is not None:
                    return res
                return _skip("heading line shows only a mammogram carve-out value; general imaging copay not found nearby", line.strip())
            return _ok(val, "sb-flat", line.strip())
        if kind == "coins" and not heading_has_place_keyword:
            return _skip("heading line shows coinsurance not copay", line.strip())
        # If the heading line itself already mentions a place-of-service keyword
        # (e.g. a PDF-rendering quirk merges the heading with its first bullet:
        # "Advanced imaging services (MRI... • Freestanding ...: $200 copay"),
        # don't trust any value found here -- it belongs to that first bullet,
        # not necessarily outpatient hospital. Fall through to scan starting
        # right after this line, which correctly picks up the real "Outpatient
        # hospital" bullet (often merged with the heading's own continuation,
        # e.g. "scans) • Outpatient hospital: $325 copay").

        # No inline value on the heading line -- skip short non-bulleted
        # continuation lines of the heading itself, e.g. a wrapped
        # "(MRI, MRA, PET and CT scans)" description line.
        j = i + 1
        skips = 0
        while j < len(lines) and skips < 4 and lines[j].strip() and not is_bullet_line(lines[j]) \
                and "$" not in lines[j] and "%" not in lines[j] and len(lines[j].strip()) < 60:
            if looks_duplicated(lines[j]):
                return _skip("jumbled multi-column layout detected near heading (duplicate label text) -- cannot reliably parse", lines[j].strip())
            j += 1
            skips += 1

        result = scan_window(lines, j)
        if result is not None:
            return result
        return _skip("advanced imaging heading found but no parseable value nearby", line.strip())

    # Heading never matched as a single contiguous line -- try the UHC-style
    # multi-column layout where "MRI, CT" and its "$N copay otherwise" value
    # end up jumbled together on one physical line despite the surrounding
    # words being interleaved from other columns.
    m = MRI_CT_OTHERWISE_RE.search(full_text)
    if m:
        return _ok(num(m.group(1)), "sb-flat-otherwise", m.group(0))

    return _skip("advanced imaging heading not found in SB text", None)


def download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return True
    try:
        r = requests.get(url, timeout=40, stream=True)
        r.raise_for_status()
        tmp = dest + ".part"
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=262144):
                f.write(chunk)
        os.replace(tmp, dest)
        return True
    except Exception as e:
        return str(e)


def process_plan(plan):
    plan_id = plan["planId"]
    url = plan["sbPdfUrl"]
    safe_name = re.sub(r"[^A-Za-z0-9_.-]", "_", plan_id)
    dest = os.path.join(CACHE_DIR, safe_name + ".pdf")

    ok = download(url, dest)
    if ok is not True:
        return {"planId": plan_id, "status": "skip", "reason": f"download failed: {ok}",
                "organizationName": plan.get("organizationName"), "oldMri": plan.get("mriCopay"), "sbDoc": url}

    try:
        with pdfplumber.open(dest) as pdf:
            # Document-type/year guard: some stored sbPdfUrl values point at a
            # stale Evidence of Coverage bundle instead of the 2026 SB. Check
            # the first few pages before trusting any benefit table found later.
            head_text = "\n".join((p.extract_text() or "") for p in pdf.pages[:3])
            is_eoc = bool(EOC_RE.search(head_text))
            is_sb = bool(SB_RE.search(head_text))
            if is_eoc and not is_sb:
                return {"planId": plan_id, "status": "skip",
                        "reason": "sbPdfUrl points to an Evidence of Coverage document, not a 2026 SB",
                        "organizationName": plan.get("organizationName"), "oldMri": plan.get("mriCopay"), "sbDoc": url}
            if "2026" not in head_text and "2025" in head_text:
                return {"planId": plan_id, "status": "skip",
                        "reason": "document shows 2025, not 2026 -- stale SB",
                        "organizationName": plan.get("organizationName"), "oldMri": plan.get("mriCopay"), "sbDoc": url}

            full_text_parts = []
            for page in pdf.pages:
                t = page.extract_text() or ""
                full_text_parts.append(t)
                if HEADING_RE.search(t):
                    # found the likely page; stop scanning further pages to save time,
                    # but keep this page's text as-is (parse_pdf_text scans block locally)
                    break
        full_text = "\n".join(full_text_parts)
        if not full_text.strip():
            return {"planId": plan_id, "status": "skip", "reason": "no extractable text (possibly scanned image)",
                    "organizationName": plan.get("organizationName"), "oldMri": plan.get("mriCopay"), "sbDoc": url}
        result = parse_pdf_text(full_text)
    except Exception as e:
        return {"planId": plan_id, "status": "skip", "reason": f"pdf parse error: {e}",
                "organizationName": plan.get("organizationName"), "oldMri": plan.get("mriCopay"), "sbDoc": url}

    result["planId"] = plan_id
    result["organizationName"] = plan.get("organizationName")
    result["oldMri"] = plan.get("mriCopay")
    result["sbDoc"] = url
    return result


def already_done():
    done = set()
    if os.path.exists(CHECKPOINT_PATH):
        with open(CHECKPOINT_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    done.add(json.loads(line)["planId"])
                except Exception:
                    pass
    return done


def finalize():
    with open(WORKLIST_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    checkpoint = {}
    if os.path.exists(CHECKPOINT_PATH):
        with open(CHECKPOINT_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                d = json.loads(line)
                pid = d["planId"]
                prev = checkpoint.get(pid)
                # Two overlapping sweep runs raced on some downloads, producing
                # duplicate lines per planId where one run hit a transient
                # file-lock error. Prefer a successful "ok" parse over a "skip"
                # (especially a download-race skip) when both exist.
                if prev is None or (prev["status"] != "ok" and d["status"] == "ok"):
                    checkpoint[pid] = d
                elif prev["status"] == d["status"]:
                    checkpoint[pid] = d  # last one wins among same-status duplicates

    fixes = []
    skipped = []
    for p in data["withUrl"]:
        d = checkpoint.get(p["planId"])
        if d is None:
            skipped.append({"planId": p["planId"], "organizationName": p.get("organizationName"),
                             "reason": "not processed (sweep incomplete)"})
            continue
        if d["status"] == "ok":
            old = d.get("oldMri")
            new = d.get("newMri")
            fixes.append({
                "planId": d["planId"], "organizationName": d.get("organizationName"),
                "oldMri": old, "newMri": new, "changed": old != new,
                "source": d.get("source"), "sbDoc": d.get("sbDoc"), "evidence": d.get("evidence"),
            })
        else:
            skipped.append({"planId": d["planId"], "organizationName": d.get("organizationName"),
                             "oldMri": d.get("oldMri"), "reason": d.get("reason"), "sbDoc": d.get("sbDoc"),
                             "evidence": d.get("evidence")})

    for p in data["noUrl"]:
        skipped.append({"planId": p["planId"], "organizationName": p.get("organizationName"), "reason": p.get("reason")})

    anchor = next((f for f in fixes if f["planId"] == ANCHOR_PLAN_ID), None)
    if not anchor or anchor["newMri"] != ANCHOR_EXPECTED:
        print(f"ANCHOR GATE FAIL at finalize: {anchor}. Not writing output.")
        sys.exit(2)

    changed = [f for f in fixes if f["changed"]]
    print(f"Fixes: {len(fixes)} total ({len(changed)} actually change a value). Skipped: {len(skipped)}.")
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump({"generatedAt": "2026-07-06", "fixes": fixes, "skipped": skipped}, f, indent=2)
    print(f"Wrote {OUT_PATH}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--only", type=str, default=None, help="comma-separated planIds")
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--finalize", action="store_true", help="aggregate checkpoint into the final fixes/skipped JSON")
    args = ap.parse_args()

    if args.finalize:
        finalize()
        return

    with open(WORKLIST_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    plans = data["withUrl"]

    if args.only:
        wanted = set(args.only.split(","))
        plans = [p for p in plans if p["planId"] in wanted]

    done = already_done()
    print(f"Total worklist plans with URL: {len(plans)}. Already checkpointed: {len(done)}.")

    # Priority: anchor first, then IMPLAUSIBLE, ORPHAN, then SPREAD-only.
    def priority(p):
        if p["planId"] == ANCHOR_PLAN_ID:
            return 0
        b = p.get("buckets", [])
        if "IMPLAUSIBLE" in b:
            return 1
        if "ORPHAN" in b:
            return 2
        return 3

    todo = [p for p in plans if p["planId"] not in done]
    todo.sort(key=priority)
    if args.limit:
        todo = todo[: args.limit]

    print(f"To process this run: {len(todo)}")

    processed = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(process_plan, p): p for p in todo}
        for fut in as_completed(futures):
            p = futures[fut]
            try:
                result = fut.result()
            except Exception as e:
                result = {"planId": p["planId"], "status": "skip", "reason": f"unhandled error: {e}",
                          "organizationName": p.get("organizationName"), "oldMri": p.get("mriCopay"), "sbDoc": p.get("sbPdfUrl")}
            with write_lock:
                with open(CHECKPOINT_PATH, "a", encoding="utf-8") as f:
                    f.write(json.dumps(result) + "\n")
            processed += 1
            if processed % 25 == 0 or result["planId"] == ANCHOR_PLAN_ID:
                elapsed = time.time() - t0
                print(f"[{processed}/{len(todo)}] {result['planId']}: {result['status']} "
                      f"({result.get('newMri', result.get('reason'))}) -- {elapsed:.0f}s elapsed", flush=True)
            if result["planId"] == ANCHOR_PLAN_ID:
                if result.get("status") == "ok" and result.get("newMri") == ANCHOR_EXPECTED:
                    print(f"ANCHOR GATE PASS: {ANCHOR_PLAN_ID} -> {result['newMri']}")
                else:
                    print(f"ANCHOR GATE FAIL: {ANCHOR_PLAN_ID} -> {result}. ABORTING RUN.", flush=True)
                    os._exit(2)

    print(f"Run complete: {processed} processed in {time.time()-t0:.0f}s.")


if __name__ == "__main__":
    main()
