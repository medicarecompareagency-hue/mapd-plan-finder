#!/usr/bin/env python3
# scripts/sb2027/classify-qmb.py — QMB cost-share-protection classifier over the 2027 D-SNP SBs.
#
#   python3 scripts/sb2027/classify-qmb.py [--budget 150] [--only H5216-164-0] [--redo-uncertain]
#
# Same rules as scripts/classify-qmb-protection.py (imported, not copied), but:
#   - reads the 2027 SBs staged by acquire.js (.cms-import-tmp/sb-2027/pdf/<key>.pdf), D-SNP plan-segments only;
#   - keyed by plan-SEGMENT (<contract>-<plan3>-<seg>), because each segment has its own SB;
#   - resumable inside a time budget (Cowork kills a call at 180 s) — run again until "left 0";
#   - caches each SB's extracted text in .cms-import-tmp/sb-2027/txt/ so later SB fixers do not re-parse the PDF.
# Writes scripts/data/qmb-protection-2027.json. It does NOT touch the database: apply with apply-qmb-2027.js.
import argparse, importlib.util, json, os, re, sys, time
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
spec = importlib.util.spec_from_file_location('cq', os.path.join(ROOT, 'scripts', 'classify-qmb-protection.py'))
cq = importlib.util.module_from_spec(spec); spec.loader.exec_module(cq)
import pdfplumber

WORK = os.path.join(ROOT, '.cms-import-tmp', 'sb-2027')
PDF, TXT = os.path.join(WORK, 'pdf'), os.path.join(WORK, 'txt')
OUT = os.path.join(ROOT, 'scripts', 'data', 'qmb-protection-2027.json')

def text_of(key):
    """Plain page text (cached). Returns '' on failure."""
    os.makedirs(TXT, exist_ok=True)
    c = os.path.join(TXT, key + '.txt')
    if os.path.exists(c):
        return open(c, encoding='utf8').read()
    with pdfplumber.open(os.path.join(PDF, key + '.pdf')) as pdf:
        full = "\n\f".join((pg.extract_text() or "") for pg in pdf.pages)
    open(c, 'w', encoding='utf8').write(full)
    return full

TXT2 = os.path.join(WORK, 'txt2col')
def cols_of(key):
    """Left-column-then-right-column text of the first pages (cached)."""
    os.makedirs(TXT2, exist_ok=True)
    c = os.path.join(TXT2, key + '.txt')
    if os.path.exists(c):
        return open(c, encoding='utf8').read()
    t = cq.extract_columns(os.path.join(PDF, key + '.pdf'), cap=6)
    open(c, 'w', encoding='utf8').write(t)
    return t

def _low(t):
    return re.sub(r"\s+", " ", cq._norm(t)).lower()

def _paren_levels(span):
    # levels from the abbreviations in parentheses only: "qualified medicare beneficiary (qmb+)" must never read as QMB
    return cq.levels_in(" , ".join(re.findall(r"\(([^)]{1,40})\)", span)))

def _category_bullets(low):
    # "...one of these Medicaid categories: • Qualified Medicare Beneficiary Plus (QMB+): ... • Qualified Medicare Beneficiary (QMB): ..."
    m = re.search(r"one of these medicaid categories[:\s]+(.{0,3000})", low)
    if not m: return set()
    return cq.levels_in(" , ".join(re.findall(r"\((qmb\+?|slmb\+?|fbde|qi(?:-1)?)\)\s*:", m.group(1))))

def post_2027(key, carrier, prot, lv, sig):
    """Rules added for 2027 SB layouts. Only runs where the 2026 rules were uncertain, or where rule 2 fired
    (rule 2 misreads UHC PPO SBs: the out-of-network column says 'if you have full Medicaid ... Otherwise, you will pay'
    even on plans whose in-network column gives standalone QMB $0)."""
    if prot is not None and not sig.startswith('rule2'):
        return prot, lv, sig
    low = _low(text_of(key))
    cats = _category_bullets(low)
    if sig.startswith('rule2'):
        if 'QMB' in cats and re.search(r"or are a qualified", low):
            return True, sorted(cats), 'rule3b:category-bullets(rule2-override)'
        return prot, lv, sig
    if carrier == 'Devoted Health':
        l2 = _low(cols_of(key))
        a = re.search(r"receive assistance from the [a-z ]{3,40}? medicaid program as an? (.{0,300}?)\. you must also live", l2)
        b = re.search(r"if you (?:have full medicaid benefits(?: or are a qualified medicare beneficiary)?|are a qualified medicare beneficiary)\s*\(([a-z0-9 ,+]+)\),? you (?:will|may) pay \$0", l2)
        la = _paren_levels(a.group(1)) if a else set()
        lb = cq.levels_in(b.group(1)) if b else None
        if la and (lb is None or ('QMB' in la) == ('QMB' in lb)):
            return 'QMB' in la, sorted(la), 'rule5b:devoted-assistance-list'
    m = re.search(r"this plan may enroll (.{0,260}?)\s*\.", low)
    if m:
        l3 = _paren_levels(m.group(1))
        if l3: return 'QMB' in l3, sorted(l3), 'rule3c:may-enroll-list'
    if not cats:   # two-column SBs (HealthSpring): the list only reads in order after de-interleaving
        cats = _category_bullets(_low(cols_of(key)))
    if cats:
        return 'QMB' in cats, sorted(cats), 'rule3b:category-bullets'
    if re.search(r"to be eligible to enroll in an? ?f(?:ide|ully-integrated)[^.]{0,200}full medicaid benefits", low):
        return False, [], 'rule7:fide-full-medicaid-required'
    return prot, lv, sig

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--budget', type=int, default=150)
    ap.add_argument('--only')
    ap.add_argument('--redo-uncertain', action='store_true')
    a = ap.parse_args()
    t0 = time.time()
    plans = json.load(open(os.path.join(WORK, 'plans.json')))
    manifest = json.load(open(os.path.join(ROOT, 'scripts', 'data', 'sb-links-2027.json')))
    out = json.load(open(OUT)) if os.path.exists(OUT) else {}
    dsnp = [e for e in plans if e['snpType'] == 'Dual-Eligible']
    todo = [e for e in dsnp if e['key'] in manifest and (not a.only or e['key'] == a.only)
            and (e['key'] not in out or a.only or out[e['key']]['signal'].startswith('mpp:') or (a.redo_uncertain and (out[e['key']]['protected'] is None or out[e['key']]['signal'].startswith('rule2'))))]
    done = 0
    for e in todo:
        if time.time() - t0 > a.budget: break
        k = e['key']
        try:
            prot, lv, sig = cq.classify(text_of(k))
            if prot is None:   # two-column retry, same as the 2026 classifier
                prot, lv, sig = cq.classify(cq.extract_columns(os.path.join(PDF, k + '.pdf')))
        except Exception as ex:
            prot, lv, sig = None, [], 'error:' + str(ex)[:80]
        try: prot, lv, sig = post_2027(k, e['carrier'], prot, lv, sig)
        except Exception as ex: sig = sig + '|post-error:' + str(ex)[:60]
        out[k] = {'planId': e['planId'], 'seg': e['seg'], 'carrier': e['carrier'], 'planName': e['planName'], 'states': e['states'],
                  'protected': prot, 'levels': lv, 'signal': sig}
        done += 1
        if a.only: print(k, out[k])
        if done % 10 == 0:
            json.dump(out, open(OUT, 'w'), indent=1)
    json.dump(out, open(OUT, 'w'), indent=1)
    have = [e for e in dsnp if e['key'] in out]
    c = lambda v: sum(1 for e in have if out[e['key']]['protected'] is v)
    print(f"this run {done}; left {len(todo) - done}; D-SNP plan-segments {len(dsnp)}: no SB {sum(1 for e in dsnp if e['key'] not in manifest)}, "
          f"classified {len(have)} -> show(true)={c(True)} hide(false)={c(False)} uncertain={c(None)}")

if __name__ == '__main__':
    main()
