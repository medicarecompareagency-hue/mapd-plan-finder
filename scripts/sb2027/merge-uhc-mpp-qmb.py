#!/usr/bin/env python3
# scripts/sb2027/merge-uhc-mpp-qmb.py — fill QMB protection for UHC 2027 D-SNPs whose SB is not posted yet.
#
# Source: scripts/data/uhc-mpp-eligibility-2027.json, read 2026-10-05 from UHC's agent-only Medicare Product Portal
# (mpp.uhc.com/plans/plan-details.<H####-###-###>.2027.html, "Special Eligibility (SNPs)" line; needs a Jarvis login).
# Rule: protected = standalone QMB is in the plan's Medicaid-level list. On the 49 UHC plan-segments that have BOTH
# an SB classification and an MPP list, the two agreed 49 of 49.
# Only fills plan-segments with no SB result; never overrides an SB-derived answer. Plans MPP shows as closed to new
# members (no level list) are left unclassified. Once the SB posts, classify-qmb.py replaces the mpp: entry.
import json, os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
OUT = os.path.join(ROOT, 'scripts', 'data', 'qmb-protection-2027.json')
mpp = json.load(open(os.path.join(ROOT, 'scripts', 'data', 'uhc-mpp-eligibility-2027.json')))
plans = {e['key']: e for e in json.load(open(os.path.join(ROOT, '.cms-import-tmp', 'sb-2027', 'plans.json')))}
out = json.load(open(OUT))
added = skipped = closed = 0
for k, m in sorted(mpp.items()):
    cur = out.get(k)
    if cur and not cur['signal'].startswith('mpp:'):
        skipped += 1; continue
    if not m['levels']:
        closed += 1; out.pop(k, None); continue
    e = plans[k]
    out[k] = {'planId': e['planId'], 'seg': e['seg'], 'carrier': e['carrier'], 'planName': e['planName'], 'states': e['states'],
              'protected': 'QMB' in m['levels'], 'levels': sorted(m['levels']), 'signal': 'mpp:uhc-special-eligibility(no-sb-yet)'}
    added += 1
json.dump(out, open(OUT, 'w'), indent=1)
print(f"mpp entries {len(mpp)}: filled {added}, already SB-classified {skipped}, closed/no list {closed}")
