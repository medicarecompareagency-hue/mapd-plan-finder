# Builds a PlanArea-format file for Regional PPO (R-contract) plans from the CMS CY2027 landscape.
# R-contracts are NOT in PlanArea.txt (they file by region), so import-cms-data.ts never sees them.
# Usage (repo root):  python3 scripts/import2027/build-regional-planarea.py <out.txt>
# Then run the importer against <out.txt> instead of pbp-2027/PlanArea.txt (see RUNBOOK.md).
import csv, json, os, sys
ST = set(json.loads(os.popen("node -e \"console.log(JSON.stringify(require('./scripts/licensed-states').LICENSED_STATES))\"").read()))
CAR = set(json.loads(os.popen("node -e \"console.log(JSON.stringify(require('./scripts/licensed-carriers').LICENSED_CARRIERS))\"").read()))
out = sys.argv[1]; n = 0; plans = set()
with open('.cms-import-tmp/cy2027-landscape/CY2027_Landscape_202609.csv', encoding='utf-8-sig') as f, open(out, 'w', newline='') as o:
    o.write('\t'.join(['pbp_a_hnumber', 'pbp_a_plan_identifier', 'segment_id', 'pbp_a_plan_type', 'stcd', 'county', 'pending_flag', 'eghp_flag']) + '\r\n')
    for r in csv.DictReader(f):
        if r['Contract Category Type'] == 'PDP' or not r['Contract ID'].startswith('R'): continue
        if r['State Territory Abbreviation'] not in ST or r['Organization Marketing Name'] not in CAR: continue
        assert r['Plan Type'].startswith('Regional PPO'), r['Plan Type']
        o.write('\t'.join([r['Contract ID'], r['Plan ID'].zfill(3), str(int(r['Segment ID'] or 0)), '31', r['State Territory Abbreviation'], r['County Name'].strip(), '', '2']) + '\r\n')
        n += 1; plans.add(r['Contract ID'] + '-' + str(int(r['Plan ID'])))
print('rows', n, 'plans', len(plans))
