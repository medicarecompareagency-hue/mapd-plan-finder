# Food Floor Audit — 2026 DSNP+CSNP Plans

*Generated 2026-07-02. READ-ONLY. 589 unique planIds.*

## Summary by Status

| Status | Count |
|--------|-------|
| FILLED | 492 |
| VERIFIED-$0 (OTC-only) | 52 |
| UNVERIFIED-retry | 43 |
| VERIFIED-$0 | 2 |

## Summary by Carrier

| Carrier | Filled | Filled-PBP | Verified-$0 | Unverified-retry |
|---------|--------|------------|-------------|------------------|
| Aetna | 108 | 0 | 0 | 0 |
| Devoted | 137 | 0 | 0 | 0 |
| HealthSpring | 4 | 0 | 28 | 0 |
| Humana | 131 | 0 | 2 | 5 |
| UHC | 95 | 0 | 2 | 31 |
| Wellcare | 17 | 0 | 22 | 7 |

## Unverified-retry Plans — with blockers

Plans are grouped by blocker type. **Fix nothing here — these are observations only.**

### Group A: Confirmed $0 via SB review — no retry needed (9 plans)
These were reviewed in prior sweeps and confirmed $0, but the DB has no positive write to mark them.

| planId | Cat | State | Carrier | Blocker |
|--------|-----|-------|---------|---------|
| H0111-4 | DSNP | GA | Wellcare | Part B giveback plan — no food card by design (Part 5 sweep) |
| H0251-8 | DSNP | TN | UHC | SB reviewed in Part 4 sweep — no monthly food credit section |
| H5216-206 | DSNP | GA | Humana | SB reviewed in Part 3 sweep — no Healthy Options benefit |
| H5216-334 | CSNP | MS | Humana | SB reviewed in Part 3 sweep — no food benefit |
| H5525-45 | DSNP | KY | Humana | SB reviewed in Part 3 sweep — no food benefit |
| H1396-1 | DSNP | SC | Humana | SB reviewed in Part 3 sweep — no food benefit |
| H2875-3 | DSNP | VA | Humana | Humana Dual Fully Integrated — different SB structure, no supplemental card (Part 3) |
| H6550-4 | DSNP | KS | Wellcare | SB reviewed in Part 5 sweep — no food section found |
| H6550-9 | DSNP | KS | Wellcare | SB reviewed in Part 5 sweep — no food section found |

### Group B: Not-found — retry after Aug 2026 re-posting (9 plans)
SBs exist but are damaged, unindexed, or not yet posted. Retry after Aug 2026.

| planId | Cat | State | Carrier | Blocker |
|--------|-----|-------|---------|---------|
| H0908-7 | DSNP | OH | Wellcare | Damaged/unindexed PDF — Part 5 DAM probe returned corrupted doc |
| H0908-8 | DSNP | OH | Wellcare | Same as H0908-7 |
| H1664-5 | DSNP | MO | Wellcare | SB not posted as of 2026-06-30 (confirmed unposted in Part 5) |
| H1664-12 | DSNP | MO | Wellcare | SB not posted as of 2026-06-30 (confirmed unposted in Part 5) |
| H5008-10 | DSNP | LA | UHC | SB not indexed via SerpAPI — Part 4 retry list |
| H5008-11 | DSNP | MS | UHC | SB not indexed via SerpAPI — Part 4 retry list |
| H5008-16 | DSNP | MS | UHC | SB not indexed via SerpAPI — Part 4 retry list |
| H5008-17 | DSNP | MS | UHC | SB not indexed via SerpAPI — Part 4 retry list |
| H0251-2 | DSNP | TN | UHC | Separate SB doc from H0251-8; not discoverable via SerpAPI (Part 4) |
| H0251-4 | DSNP | TN | UHC | Same as H0251-2 |
| H2385-1 | DSNP | IN | UHC | SB not discoverable via SerpAPI (Part 4 retry list) |
| H2385-3 | DSNP | IN | UHC | Same as H2385-1 |
| H2445-2 | DSNP | VA | UHC | SB not discoverable via SerpAPI (Part 4 retry list) |
| H2445-3 | DSNP | VA | UHC | Same as H2445-2 |

### Group C: Unswept UHC plans — not yet chased (21 plans)
These UHC DSNP plans were not targeted in Part 4 (which focused on specific families). Need dedicated SB chase.

| planId | Cat | State | Carrier | Notes |
|--------|-----|-------|---------|-------|
| H1889-2 | DSNP | FL | UHC | H1889 anchor=H1889-9 TX $75/mo; this plan not swept |
| H1889-25 | CSNP | AR | UHC | H1889 family not fully swept |
| H1889-26 | DSNP | FL | UHC | H1889 family not fully swept |
| H1889-8 | DSNP | KY | UHC | H1889 family not fully swept |
| H1889-10 | DSNP | LA | UHC | H1889 family not fully swept |
| H1889-11 | DSNP | MS | UHC | H1889 family not fully swept |
| H1889-30 | DSNP | KY | UHC | H1889 family not fully swept |
| H1889-31 | DSNP | LA | UHC | H1889 family not fully swept |
| H1889-32 | DSNP | MS | UHC | H1889 family not fully swept |
| H5322-26 | DSNP | TX | UHC | H5322 family not swept |
| H5322-31 | DSNP | OK | UHC | H5322 family not swept |
| H5322-33 | DSNP | OK | UHC | H5322 family not swept |
| H5322-38 | DSNP | TX | UHC | H5322 family not swept |
| H5322-49 | DSNP | GA | UHC | H5322 family not swept |
| H6595-3 | DSNP | KY | UHC | H6595 family not swept |
| H6595-5 | DSNP | KY | UHC | H6595 family not swept |
| H0169-2 | DSNP | MO | UHC | H0169 family not swept (known high-value: H0169-10 already filled) |
| H0169-4 | DSNP | KS | UHC | H0169 family not swept |
| H0169-8 | DSNP | MO | UHC | H0169 family not swept |
| H0421-1 | DSNP | VA | UHC | H0421 family not swept |

## All Plans Detail

| planId | Cat | State | Carrier | EffectiveFood | Source | Status |
|--------|-----|-------|---------|---------------|--------|--------|
| H0432-13 | DSNP | AL | UHC | 420 | sbVerifiedFood | FILLED |
| H0432-17 | CSNP | AL | UHC | 660 | sbVerifiedFood | FILLED |
| H0432-9 | DSNP | AL | UHC | 900 | sbVerifiedFood | FILLED |
| H1889-9 | DSNP | AL | UHC | 900 | sbVerifiedFood | FILLED |
| H2802-44 | DSNP | AL | UHC | 996 | sbVerifiedFood | FILLED |
| H2802-64 | DSNP | AL | UHC | 2160 | sbVerifiedFood | FILLED |
| H3080-3 | DSNP | AL | Devoted | 2544 | sbVerifiedFood | FILLED |
| H3080-4 | DSNP | AL | Devoted | 2124 | sbVerifiedFood | FILLED |
| H3080-6 | DSNP | AL | Devoted | 2400 | sbVerifiedFood | FILLED |
| H3080-7 | DSNP | AL | Devoted | 1980 | sbVerifiedFood | FILLED |
| H3239-10 | DSNP | AL | Aetna | 480 | foodCardAllowance | FILLED |
| H3239-2 | DSNP | AL | Aetna | 1440 | foodCardAllowance | FILLED |
| H3239-26 | DSNP | AL | Aetna | 1800 | foodCardAllowance | FILLED |
| H4461-74 | DSNP | AL | Humana | 1200 | sbVerifiedFood | FILLED |
| H4461-76 | DSNP | AL | Humana | 2520 | sbVerifiedFood | FILLED |
| H4461-77 | DSNP | AL | Humana | 1200 | sbVerifiedFood | FILLED |
| H4513-55 | DSNP | AL | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H4513-63 | DSNP | AL | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H4513-94 | CSNP | AL | HealthSpring | 400 | foodCardAllowance | FILLED |
| H5216-370 | DSNP | AL | Humana | 2100 | sbVerifiedFood | FILLED |
| H5619-93 | DSNP | AL | Humana | 1200 | sbVerifiedFood | FILLED |
| H9888-10 | CSNP | AL | Devoted | 588 | sbVerifiedFood | FILLED |
| H9888-11 | CSNP | AL | Devoted | 2400 | sbVerifiedFood | FILLED |
| H9888-12 | CSNP | AL | Devoted | 321 | ssbciFood(PBP) | FILLED |
| H9888-13 | DSNP | AL | Devoted | 3552 | sbVerifiedFood | FILLED |
| H9888-14 | DSNP | AL | Devoted | 3192 | sbVerifiedFood | FILLED |
| H9888-15 | CSNP | AL | Devoted | 291 | ssbciFood(PBP) | FILLED |
| H9888-8 | CSNP | AL | Devoted | 588 | sbVerifiedFood | FILLED |
| H9888-9 | CSNP | AL | Devoted | 2400 | sbVerifiedFood | FILLED |
| H1416-33 | DSNP | AR | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1416-43 | DSNP | AR | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1608-76 | DSNP | AR | Aetna | 1260 | foodCardAllowance | FILLED |
| H1608-77 | DSNP | AR | Aetna | 540 | foodCardAllowance | FILLED |
| H1889-19 | CSNP | AR | UHC | 480 | foodCardAllowance | FILLED |
| H1889-25 | CSNP | AR | UHC | 0 | $0 | UNVERIFIED-retry |
| H2001-34 | DSNP | AR | UHC | 1500 | sbVerifiedFood | FILLED |
| H2001-35 | DSNP | AR | UHC | 540 | sbVerifiedFood | FILLED |
| H2001-65 | DSNP | AR | UHC | 2556 | sbVerifiedFood | FILLED |
| H2663-97 | DSNP | AR | Aetna | 2280 | foodCardAllowance | FILLED |
| H4513-39 | DSNP | AR | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H4513-81 | DSNP | AR | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H5216-219 | DSNP | AR | Humana | 1200 | sbVerifiedFood | FILLED |
| H5216-361 | DSNP | AR | Humana | 1200 | sbVerifiedFood | FILLED |
| H5216-366 | CSNP | AR | Humana | 480 | sbVerifiedFood | FILLED |
| H5216-470 | DSNP | AR | Humana | 2700 | sbVerifiedFood | FILLED |
| H5325-11 | DSNP | AR | Aetna | 660 | foodCardAllowance | FILLED |
| H5325-7 | DSNP | AR | Aetna | 1560 | foodCardAllowance | FILLED |
| H5619-123 | DSNP | AR | Humana | 1500 | sbVerifiedFood | FILLED |
| H7397-10 | CSNP | AR | Devoted | 314 | ssbciFood(PBP) | FILLED |
| H7397-3 | DSNP | AR | Devoted | 2640 | foodCardAllowance | FILLED |
| H7397-4 | DSNP | AR | Devoted | 91 | ssbciFood(PBP) | FILLED |
| H7397-6 | CSNP | AR | Devoted | 588 | foodCardAllowance | FILLED |
| H7397-7 | CSNP | AR | Devoted | 2256 | foodCardAllowance | FILLED |
| H7397-9 | DSNP | AR | Devoted | 3300 | foodCardAllowance | FILLED |
| H7617-74 | DSNP | AR | Humana | 1200 | sbVerifiedFood | FILLED |
| H7617-75 | DSNP | AR | Humana | 2700 | sbVerifiedFood | FILLED |
| H7617-77 | CSNP | AR | Humana | 480 | sbVerifiedFood | FILLED |
| H1032-202 | DSNP | FL | Wellcare | 600 | foodCardAllowance | FILLED |
| H1032-240 | DSNP | FL | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1032-241 | DSNP | FL | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1032-242 | DSNP | FL | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1032-243 | DSNP | FL | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1032-244 | DSNP | FL | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1032-245 | DSNP | FL | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1036-102 | DSNP | FL | Humana | 1500 | sbVerifiedFood | FILLED |
| H1036-121 | CSNP | FL | Humana | 420 | sbVerifiedFood | FILLED |
| H1036-209 | DSNP | FL | Humana | 1500 | sbVerifiedFood | FILLED |
| H1036-210 | DSNP | FL | Humana | 1200 | sbVerifiedFood | FILLED |
| H1036-213 | DSNP | FL | Humana | 1500 | sbVerifiedFood | FILLED |
| H1036-214 | DSNP | FL | Humana | 1200 | sbVerifiedFood | FILLED |
| H1036-226 | DSNP | FL | Humana | 1200 | sbVerifiedFood | FILLED |
| H1036-280 | DSNP | FL | Humana | 4980 | sbVerifiedFood | FILLED |
| H1036-285 | DSNP | FL | Humana | 1200 | sbVerifiedFood | FILLED |
| H1036-292 | CSNP | FL | Humana | 840 | sbVerifiedFood | FILLED |
| H1036-297 | CSNP | FL | Humana | 780 | sbVerifiedFood | FILLED |
| H1036-298 | CSNP | FL | Humana | 720 | sbVerifiedFood | FILLED |
| H1036-299 | CSNP | FL | Humana | 600 | sbVerifiedFood | FILLED |
| H1036-300 | CSNP | FL | Humana | 540 | sbVerifiedFood | FILLED |
| H1036-301 | CSNP | FL | Humana | 600 | sbVerifiedFood | FILLED |
| H1036-302 | CSNP | FL | Humana | 900 | sbVerifiedFood | FILLED |
| H1036-304 | DSNP | FL | Humana | 3000 | sbVerifiedFood | FILLED |
| H1036-310 | CSNP | FL | Humana | 360 | sbVerifiedFood | FILLED |
| H1036-311 | CSNP | FL | Humana | 360 | sbVerifiedFood | FILLED |
| H1036-312 | CSNP | FL | Humana | 840 | sbVerifiedFood | FILLED |
| H1036-313 | CSNP | FL | Humana | 600 | sbVerifiedFood | FILLED |
| H1036-314 | DSNP | FL | Humana | 3000 | sbVerifiedFood | FILLED |
| H1036-315 | CSNP | FL | Humana | 780 | sbVerifiedFood | FILLED |
| H1036-316 | CSNP | FL | Humana | 780 | sbVerifiedFood | FILLED |
| H1036-336 | CSNP | FL | Humana | 300 | sbVerifiedFood | FILLED |
| H1036-337 | CSNP | FL | Humana | 300 | sbVerifiedFood | FILLED |
| H1036-338 | CSNP | FL | Humana | 2340 | sbVerifiedFood | FILLED |
| H1036-339 | DSNP | FL | Humana | 4320 | sbVerifiedFood | FILLED |
| H1036-340 | DSNP | FL | Humana | 4200 | sbVerifiedFood | FILLED |
| H1036-341 | DSNP | FL | Humana | 4200 | sbVerifiedFood | FILLED |
| H1036-77 | DSNP | FL | Humana | 1500 | sbVerifiedFood | FILLED |
| H1045-12 | DSNP | FL | UHC | 2928 | sbVerifiedFood | FILLED |
| H1045-18 | CSNP | FL | UHC | 480 | sbVerifiedFood | FILLED |
| H1045-38 | DSNP | FL | UHC | 2808 | sbVerifiedFood | FILLED |
| H1045-39 | DSNP | FL | UHC | 2748 | sbVerifiedFood | FILLED |
| H1045-48 | CSNP | FL | UHC | 492 | sbVerifiedFood | FILLED |
| H1045-61 | DSNP | FL | UHC | 1548 | sbVerifiedFood | FILLED |
| H1045-63 | DSNP | FL | UHC | 4320 | foodCardAllowance | FILLED |
| H1045-64 | DSNP | FL | UHC | 636 | sbVerifiedFood | FILLED |
| H1045-65 | DSNP | FL | UHC | 4248 | sbVerifiedFood | FILLED |
| H1290-19 | DSNP | FL | Devoted | 1956 | sbVerifiedFood | FILLED |
| H1290-20 | DSNP | FL | Devoted | 1872 | sbVerifiedFood | FILLED |
| H1290-21 | DSNP | FL | Devoted | 1872 | sbVerifiedFood | FILLED |
| H1290-22 | DSNP | FL | Devoted | 1872 | sbVerifiedFood | FILLED |
| H1290-23 | DSNP | FL | Devoted | 1872 | sbVerifiedFood | FILLED |
| H1290-24 | DSNP | FL | Devoted | 1812 | sbVerifiedFood | FILLED |
| H1290-33 | DSNP | FL | Devoted | 1824 | sbVerifiedFood | FILLED |
| H1290-34 | DSNP | FL | Devoted | 1944 | sbVerifiedFood | FILLED |
| H1290-39 | DSNP | FL | Devoted | 1860 | sbVerifiedFood | FILLED |
| H1290-41 | DSNP | FL | Devoted | 1884 | sbVerifiedFood | FILLED |
| H1290-42 | DSNP | FL | Devoted | 3264 | foodCardAllowance | FILLED |
| H1290-43 | DSNP | FL | Devoted | 1728 | sbVerifiedFood | FILLED |
| H1290-52 | DSNP | FL | Devoted | 3156 | sbVerifiedFood | FILLED |
| H1290-53 | DSNP | FL | Devoted | 3408 | sbVerifiedFood | FILLED |
| H1290-54 | DSNP | FL | Devoted | 3456 | foodCardAllowance | FILLED |
| H1290-55 | DSNP | FL | Devoted | 3468 | foodCardAllowance | FILLED |
| H1290-67 | CSNP | FL | Devoted | 2880 | sbVerifiedFood | FILLED |
| H1290-68 | CSNP | FL | Devoted | 2880 | sbVerifiedFood | FILLED |
| H1290-69 | CSNP | FL | Devoted | 2880 | sbVerifiedFood | FILLED |
| H1290-70 | CSNP | FL | Devoted | 2880 | sbVerifiedFood | FILLED |
| H1290-71 | CSNP | FL | Devoted | 2880 | sbVerifiedFood | FILLED |
| H1290-72 | CSNP | FL | Devoted | 2880 | sbVerifiedFood | FILLED |
| H1290-73 | CSNP | FL | Devoted | 2880 | sbVerifiedFood | FILLED |
| H1290-74 | CSNP | FL | Devoted | 2880 | sbVerifiedFood | FILLED |
| H1290-77 | DSNP | FL | Devoted | 5112 | sbVerifiedFood | FILLED |
| H1290-78 | DSNP | FL | Devoted | 5100 | sbVerifiedFood | FILLED |
| H1290-79 | DSNP | FL | Devoted | 5112 | sbVerifiedFood | FILLED |
| H1290-80 | DSNP | FL | Devoted | 5112 | sbVerifiedFood | FILLED |
| H1290-81 | DSNP | FL | Devoted | 5112 | sbVerifiedFood | FILLED |
| H1290-82 | DSNP | FL | Devoted | 5100 | sbVerifiedFood | FILLED |
| H1290-83 | DSNP | FL | Devoted | 5112 | sbVerifiedFood | FILLED |
| H1290-84 | CSNP | FL | Devoted | 5904 | sbVerifiedFood | FILLED |
| H1290-85 | CSNP | FL | Devoted | 5880 | sbVerifiedFood | FILLED |
| H1290-86 | CSNP | FL | Devoted | 5916 | sbVerifiedFood | FILLED |
| H1290-87 | CSNP | FL | Devoted | 5880 | sbVerifiedFood | FILLED |
| H1290-88 | CSNP | FL | Devoted | 5880 | sbVerifiedFood | FILLED |
| H1290-89 | CSNP | FL | Devoted | 5880 | sbVerifiedFood | FILLED |
| H1290-90 | CSNP | FL | Devoted | 5880 | sbVerifiedFood | FILLED |
| H1290-91 | CSNP | FL | Devoted | 5868 | sbVerifiedFood | FILLED |
| H1609-17 | DSNP | FL | Aetna | 1680 | foodCardAllowance | FILLED |
| H1609-19 | DSNP | FL | Aetna | 960 | foodCardAllowance | FILLED |
| H1609-43 | DSNP | FL | Aetna | 2700 | foodCardAllowance | FILLED |
| H1609-44 | DSNP | FL | Aetna | 2580 | foodCardAllowance | FILLED |
| H1609-45 | DSNP | FL | Aetna | 2280 | foodCardAllowance | FILLED |
| H1609-46 | DSNP | FL | Aetna | 2040 | foodCardAllowance | FILLED |
| H1609-47 | DSNP | FL | Aetna | 2220 | foodCardAllowance | FILLED |
| H1609-48 | DSNP | FL | Aetna | 3120 | foodCardAllowance | FILLED |
| H1609-49 | DSNP | FL | Aetna | 2580 | foodCardAllowance | FILLED |
| H1609-55 | DSNP | FL | Aetna | 2220 | foodCardAllowance | FILLED |
| H1609-56 | DSNP | FL | Aetna | 2304 | foodCardAllowance | FILLED |
| H1609-61 | DSNP | FL | Aetna | 2040 | foodCardAllowance | FILLED |
| H1609-62 | DSNP | FL | Aetna | 2100 | foodCardAllowance | FILLED |
| H1609-64 | DSNP | FL | Aetna | 2100 | foodCardAllowance | FILLED |
| H1609-73 | DSNP | FL | Aetna | 3480 | foodCardAllowance | FILLED |
| H1609-74 | DSNP | FL | Aetna | 2940 | foodCardAllowance | FILLED |
| H1609-75 | DSNP | FL | Aetna | 3000 | foodCardAllowance | FILLED |
| H1609-76 | DSNP | FL | Aetna | 3240 | foodCardAllowance | FILLED |
| H1609-77 | DSNP | FL | Aetna | 2880 | foodCardAllowance | FILLED |
| H1609-78 | DSNP | FL | Aetna | 2820 | foodCardAllowance | FILLED |
| H1609-79 | DSNP | FL | Aetna | 2820 | foodCardAllowance | FILLED |
| H1609-80 | CSNP | FL | Aetna | 720 | foodCardAllowance | FILLED |
| H1609-81 | CSNP | FL | Aetna | 720 | foodCardAllowance | FILLED |
| H1609-82 | CSNP | FL | Aetna | 420 | foodCardAllowance | FILLED |
| H1609-83 | CSNP | FL | Aetna | 660 | foodCardAllowance | FILLED |
| H1609-84 | CSNP | FL | Aetna | 600 | foodCardAllowance | FILLED |
| H1609-85 | CSNP | FL | Aetna | 660 | foodCardAllowance | FILLED |
| H1609-88 | DSNP | FL | Aetna | 3240 | foodCardAllowance | FILLED |
| H1609-89 | DSNP | FL | Aetna | 2640 | foodCardAllowance | FILLED |
| H1609-90 | DSNP | FL | Aetna | 3660 | foodCardAllowance | FILLED |
| H1609-92 | DSNP | FL | Aetna | 2820 | foodCardAllowance | FILLED |
| H1609-94 | CSNP | FL | Aetna | 720 | foodCardAllowance | FILLED |
| H1889-2 | DSNP | FL | UHC | 0 | $0 | UNVERIFIED-retry |
| H1889-26 | DSNP | FL | UHC | 0 | $0 | UNVERIFIED-retry |
| H2509-1 | DSNP | FL | UHC | 5016 | foodCardAllowance | FILLED |
| H2509-2 | DSNP | FL | UHC | 2748 | foodCardAllowance | FILLED |
| H2509-3 | DSNP | FL | UHC | 4188 | foodCardAllowance | FILLED |
| H5216-394 | DSNP | FL | Humana | 1080 | sbVerifiedFood | FILLED |
| H5410-13 | DSNP | FL | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H5410-25 | DSNP | FL | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H5410-31 | DSNP | FL | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H5410-32 | DSNP | FL | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H5410-42 | DSNP | FL | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H5410-45 | DSNP | FL | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H5410-46 | DSNP | FL | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H5410-47 | DSNP | FL | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H5410-55 | DSNP | FL | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H5410-56 | DSNP | FL | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H5420-14 | CSNP | FL | UHC | 480 | sbVerifiedFood | FILLED |
| H5420-15 | DSNP | FL | UHC | 1008 | sbVerifiedFood | FILLED |
| H5420-16 | DSNP | FL | UHC | 3564 | foodCardAllowance | FILLED |
| H5420-6 | DSNP | FL | UHC | 2568 | sbVerifiedFood | FILLED |
| H5652-4 | CSNP | FL | UHC | 420 | sbVerifiedFood | FILLED |
| H7284-10 | DSNP | FL | Humana | 1080 | sbVerifiedFood | FILLED |
| H7617-113 | DSNP | FL | Humana | 1080 | sbVerifiedFood | FILLED |
| H0111-4 | DSNP | GA | Wellcare | 0 | $0 | UNVERIFIED-retry |
| H0439-12 | DSNP | GA | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H0439-2 | DSNP | GA | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1112-33 | DSNP | GA | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1112-46 | DSNP | GA | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1112-47 | DSNP | GA | Wellcare | 1092 | foodCardAllowance | FILLED |
| H1112-48 | DSNP | GA | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1112-6 | DSNP | GA | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1889-20 | CSNP | GA | UHC | 480 | foodCardAllowance | FILLED |
| H1889-28 | CSNP | GA | UHC | 1080 | foodCardAllowance | FILLED |
| H2293-2 | DSNP | GA | Aetna | 1320 | foodCardAllowance | FILLED |
| H2293-21 | DSNP | GA | Aetna | 1260 | foodCardAllowance | FILLED |
| H2293-35 | CSNP | GA | Aetna | 300 | foodCardAllowance | FILLED |
| H2293-4 | DSNP | GA | Aetna | 600 | foodCardAllowance | FILLED |
| H2406-52 | DSNP | GA | UHC | 624 | sbVerifiedFood | FILLED |
| H3256-4 | DSNP | GA | UHC | 2328 | foodCardAllowance | FILLED |
| H3256-5 | DSNP | GA | UHC | 1212 | foodCardAllowance | FILLED |
| H3256-6 | DSNP | GA | UHC | 768 | foodCardAllowance | FILLED |
| H4141-24 | DSNP | GA | Humana | 3060 | sbVerifiedFood | FILLED |
| H4141-25 | DSNP | GA | Humana | 2100 | sbVerifiedFood | FILLED |
| H4141-3 | DSNP | GA | Humana | 1080 | sbVerifiedFood | FILLED |
| H4513-79 | DSNP | GA | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H4513-80 | DSNP | GA | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H5216-205 | DSNP | GA | Humana | 1080 | sbVerifiedFood | FILLED |
| H5216-206 | DSNP | GA | Humana | 0 | $0 | UNVERIFIED-retry |
| H5216-246 | CSNP | GA | Humana | 420 | sbVerifiedFood | FILLED |
| H5302-12 | DSNP | GA | Aetna | 1560 | foodCardAllowance | FILLED |
| H5302-20 | DSNP | GA | Aetna | 600 | foodCardAllowance | FILLED |
| H5302-24 | DSNP | GA | Aetna | 2520 | foodCardAllowance | FILLED |
| H5302-26 | CSNP | GA | Aetna | 360 | foodCardAllowance | FILLED |
| H5322-49 | DSNP | GA | UHC | 0 | $0 | UNVERIFIED-retry |
| H5322-50 | DSNP | GA | UHC | 1572 | foodCardAllowance | FILLED |
| H5453-15 | CSNP | GA | Devoted | 1800 | foodCardAllowance | FILLED |
| H5453-16 | CSNP | GA | Devoted | 343 | ssbciFood(PBP) | FILLED |
| H5453-17 | CSNP | GA | Devoted | 2400 | foodCardAllowance | FILLED |
| H5453-18 | CSNP | GA | Devoted | 2400 | foodCardAllowance | FILLED |
| H1206-4 | CSNP | IL | Aetna | 480 | foodCardAllowance | FILLED |
| H1206-9 | CSNP | IL | Aetna | 1200 | foodCardAllowance | FILLED |
| H1468-17 | CSNP | IL | Humana | 900 | sbVerifiedFood | FILLED |
| H2001-37 | CSNP | IL | UHC | 2568 | sbVerifiedFood | FILLED |
| H2001-38 | CSNP | IL | UHC | 2592 | sbVerifiedFood | FILLED |
| H2663-100 | CSNP | IL | Aetna | 360 | foodCardAllowance | FILLED |
| H2802-67 | CSNP | IL | UHC | 1128 | sbVerifiedFood | FILLED |
| H4329-1 | DSNP | IL | Humana | 500 | ssbciFood(PBP) | FILLED |
| H5216-414 | CSNP | IL | Humana | 1260 | sbVerifiedFood | FILLED |
| H5253-180 | CSNP | IL | UHC | 480 | sbVerifiedFood | FILLED |
| H7151-5 | CSNP | IL | Devoted | 1800 | sbVerifiedFood | FILLED |
| H7151-6 | CSNP | IL | Devoted | 4332 | sbVerifiedFood | FILLED |
| H8320-11 | CSNP | IL | Devoted | 2400 | foodCardAllowance | FILLED |
| H8320-12 | CSNP | IL | Devoted | 323 | ssbciFood(PBP) | FILLED |
| H8320-13 | CSNP | IL | Devoted | 2400 | foodCardAllowance | FILLED |
| H8320-14 | CSNP | IL | Devoted | 2400 | foodCardAllowance | FILLED |
| H2385-1 | DSNP | IN | UHC | 0 | $0 | UNVERIFIED-retry |
| H2385-2 | DSNP | IN | UHC | 1116 | foodCardAllowance | FILLED |
| H2385-3 | DSNP | IN | UHC | 0 | $0 | UNVERIFIED-retry |
| H2385-4 | DSNP | IN | UHC | 4536 | foodCardAllowance | FILLED |
| H2802-68 | CSNP | IN | UHC | 540 | sbVerifiedFood | FILLED |
| H3192-28 | CSNP | IN | Aetna | 996 | foodCardAllowance | FILLED |
| H3192-29 | CSNP | IN | Aetna | 1056 | foodCardAllowance | FILLED |
| H4939-1 | DSNP | IN | Humana | 1000 | ssbciFood(PBP) | FILLED |
| H4939-2 | DSNP | IN | Humana | 1380 | sbVerifiedFood | FILLED |
| H4939-3 | DSNP | IN | Humana | 1500 | sbVerifiedFood | FILLED |
| H5619-170 | CSNP | IN | Humana | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H5619-55 | CSNP | IN | Humana | 600 | sbVerifiedFood | FILLED |
| H7471-13 | CSNP | IN | Devoted | 340 | ssbciFood(PBP) | FILLED |
| H7471-14 | CSNP | IN | Devoted | 2400 | foodCardAllowance | FILLED |
| H7471-15 | CSNP | IN | Devoted | 2400 | foodCardAllowance | FILLED |
| H7471-16 | CSNP | IN | Devoted | 2400 | foodCardAllowance | FILLED |
| H7471-17 | CSNP | IN | Devoted | 2400 | foodCardAllowance | FILLED |
| H0028-56 | CSNP | KS | Humana | 360 | sbVerifiedFood | FILLED |
| H0028-67 | CSNP | KS | Humana | 1800 | sbVerifiedFood | FILLED |
| H0169-10 | DSNP | KS | UHC | 1464 | foodCardAllowance | FILLED |
| H0169-4 | DSNP | KS | UHC | 0 | $0 | UNVERIFIED-retry |
| H2663-98 | CSNP | KS | Aetna | 600 | foodCardAllowance | FILLED |
| H2663-99 | CSNP | KS | Aetna | 2400 | foodCardAllowance | FILLED |
| H2802-70 | CSNP | KS | UHC | 0 | $0 | VERIFIED-$0 |
| H4348-3 | CSNP | KS | Devoted | 2400 | foodCardAllowance | FILLED |
| H4348-4 | CSNP | KS | Devoted | 359 | ssbciFood(PBP) | FILLED |
| H4348-7 | CSNP | KS | Devoted | 2400 | foodCardAllowance | FILLED |
| H5322-29 | DSNP | KS | UHC | 2364 | foodCardAllowance | FILLED |
| H6550-4 | DSNP | KS | Wellcare | 0 | $0 | UNVERIFIED-retry |
| H6550-9 | DSNP | KS | Wellcare | 0 | $0 | UNVERIFIED-retry |
| H9387-4 | DSNP | KS | Wellcare | 1140 | foodCardAllowance | FILLED |
| H0628-12 | DSNP | KY | Aetna | 2040 | foodCardAllowance | FILLED |
| H0628-40 | DSNP | KY | Aetna | 1200 | foodCardAllowance | FILLED |
| H1036-234 | CSNP | KY | Humana | 600 | sbVerifiedFood | FILLED |
| H1036-235 | DSNP | KY | Humana | 2220 | sbVerifiedFood | FILLED |
| H1036-320 | DSNP | KY | Humana | 2460 | sbVerifiedFood | FILLED |
| H1889-30 | DSNP | KY | UHC | 0 | $0 | UNVERIFIED-retry |
| H1889-8 | DSNP | KY | UHC | 0 | $0 | UNVERIFIED-retry |
| H3975-4 | DSNP | KY | Wellcare | 1536 | foodCardAllowance | FILLED |
| H5253-182 | CSNP | KY | UHC | 480 | sbVerifiedFood | FILLED |
| H5253-190 | CSNP | KY | UHC | 1020 | sbVerifiedFood | FILLED |
| H5525-45 | DSNP | KY | Humana | 0 | $0 | UNVERIFIED-retry |
| H5619-163 | DSNP | KY | Humana | 2040 | sbVerifiedFood | FILLED |
| H5619-75 | DSNP | KY | Humana | 1380 | sbVerifiedFood | FILLED |
| H5718-4 | CSNP | KY | Devoted | 287 | ssbciFood(PBP) | FILLED |
| H5718-5 | CSNP | KY | Devoted | 2400 | foodCardAllowance | FILLED |
| H5718-6 | CSNP | KY | Devoted | 2400 | foodCardAllowance | FILLED |
| H6595-3 | DSNP | KY | UHC | 0 | $0 | UNVERIFIED-retry |
| H6595-4 | DSNP | KY | UHC | 1680 | foodCardAllowance | FILLED |
| H6595-5 | DSNP | KY | UHC | 0 | $0 | UNVERIFIED-retry |
| H6622-17 | CSNP | KY | Humana | 420 | sbVerifiedFood | FILLED |
| H6622-18 | DSNP | KY | Humana | 1800 | sbVerifiedFood | FILLED |
| H9730-11 | DSNP | KY | Wellcare | 960 | foodCardAllowance | FILLED |
| H9730-3 | DSNP | KY | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H9730-4 | DSNP | KY | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1889-10 | DSNP | LA | UHC | 0 | $0 | UNVERIFIED-retry |
| H1889-31 | DSNP | LA | UHC | 0 | $0 | UNVERIFIED-retry |
| H1951-32 | DSNP | LA | Humana | 1920 | sbVerifiedFood | FILLED |
| H1951-41 | DSNP | LA | Humana | 1500 | sbVerifiedFood | FILLED |
| H1951-44 | CSNP | LA | Humana | 1320 | sbVerifiedFood | FILLED |
| H1951-56 | DSNP | LA | Humana | 1200 | sbVerifiedFood | FILLED |
| H1951-57 | DSNP | LA | Humana | 2700 | sbVerifiedFood | FILLED |
| H1951-61 | DSNP | LA | Humana | 3420 | sbVerifiedFood | FILLED |
| H2491-25 | DSNP | LA | Wellcare | 1080 | foodCardAllowance | FILLED |
| H2491-32 | DSNP | LA | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H2491-33 | DSNP | LA | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H3239-1 | DSNP | LA | Aetna | 1884 | foodCardAllowance | FILLED |
| H3239-23 | DSNP | LA | Aetna | 30 | ssbciFood(PBP) | FILLED |
| H3239-27 | DSNP | LA | Aetna | 2820 | foodCardAllowance | FILLED |
| H3239-30 | CSNP | LA | Aetna | 732 | foodCardAllowance | FILLED |
| H3239-7 | DSNP | LA | Aetna | 2040 | foodCardAllowance | FILLED |
| H5008-10 | DSNP | LA | UHC | 0 | $0 | UNVERIFIED-retry |
| H5216-330 | DSNP | LA | Humana | 1200 | sbVerifiedFood | FILLED |
| H5216-332 | DSNP | LA | Humana | 600 | sbVerifiedFood | FILLED |
| H5521-472 | DSNP | LA | Aetna | 1440 | foodCardAllowance | FILLED |
| H7766-12 | CSNP | LA | Devoted | 2304 | foodCardAllowance | FILLED |
| H7766-13 | CSNP | LA | Devoted | 2304 | foodCardAllowance | FILLED |
| H7766-14 | CSNP | LA | Devoted | 359 | ssbciFood(PBP) | FILLED |
| H7766-15 | DSNP | LA | Devoted | 333 | ssbciFood(PBP) | FILLED |
| H7766-4 | DSNP | LA | Devoted | 192 | ssbciFood(PBP) | FILLED |
| H0028-15 | DSNP | MO | Humana | 1200 | sbVerifiedFood | FILLED |
| H0028-51 | CSNP | MO | Humana | 720 | sbVerifiedFood | FILLED |
| H0028-55 | CSNP | MO | Humana | 720 | sbVerifiedFood | FILLED |
| H0169-2 | DSNP | MO | UHC | 0 | $0 | UNVERIFIED-retry |
| H0169-8 | DSNP | MO | UHC | 0 | $0 | UNVERIFIED-retry |
| H0169-9 | DSNP | MO | UHC | 3336 | foodCardAllowance | FILLED |
| H0439-22 | DSNP | MO | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H0439-23 | DSNP | MO | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1664-12 | DSNP | MO | Wellcare | 0 | $0 | UNVERIFIED-retry |
| H1664-5 | DSNP | MO | Wellcare | 0 | $0 | UNVERIFIED-retry |
| H2001-40 | DSNP | MO | UHC | 1428 | sbVerifiedFood | FILLED |
| H2001-55 | CSNP | MO | UHC | 492 | sbVerifiedFood | FILLED |
| H2041-11 | DSNP | MO | Devoted | 3984 | foodCardAllowance | FILLED |
| H2041-12 | CSNP | MO | Devoted | 2400 | foodCardAllowance | FILLED |
| H2041-13 | CSNP | MO | Devoted | 2400 | foodCardAllowance | FILLED |
| H2041-14 | CSNP | MO | Devoted | 2400 | foodCardAllowance | FILLED |
| H2041-15 | CSNP | MO | Devoted | 2400 | foodCardAllowance | FILLED |
| H2041-16 | CSNP | MO | Devoted | 4608 | foodCardAllowance | FILLED |
| H2041-7 | DSNP | MO | Devoted | 3684 | foodCardAllowance | FILLED |
| H2041-8 | DSNP | MO | Devoted | 1416 | foodCardAllowance | FILLED |
| H2663-102 | CSNP | MO | Aetna | 600 | foodCardAllowance | FILLED |
| H4461-44 | DSNP | MO | Humana | 3300 | sbVerifiedFood | FILLED |
| H5216-164 | DSNP | MO | Humana | 1200 | sbVerifiedFood | FILLED |
| H5325-12 | DSNP | MO | Aetna | 3000 | foodCardAllowance | FILLED |
| H5325-13 | DSNP | MO | Aetna | 3300 | foodCardAllowance | FILLED |
| H5325-14 | DSNP | MO | Aetna | 3300 | foodCardAllowance | FILLED |
| H5325-15 | DSNP | MO | Aetna | 3300 | foodCardAllowance | FILLED |
| H5325-3 | DSNP | MO | Aetna | 2400 | foodCardAllowance | FILLED |
| H5325-4 | DSNP | MO | Aetna | 2700 | foodCardAllowance | FILLED |
| H5325-5 | DSNP | MO | Aetna | 2700 | foodCardAllowance | FILLED |
| H5325-6 | DSNP | MO | Aetna | 2700 | foodCardAllowance | FILLED |
| H7518-3 | DSNP | MO | Wellcare | 1560 | foodCardAllowance | FILLED |
| H7617-6 | DSNP | MO | Humana | 3300 | sbVerifiedFood | FILLED |
| H0074-4 | DSNP | MS | Wellcare | 924 | foodCardAllowance | FILLED |
| H1036-222 | DSNP | MS | Humana | 1200 | sbVerifiedFood | FILLED |
| H1036-328 | DSNP | MS | Humana | 3120 | sbVerifiedFood | FILLED |
| H1036-329 | DSNP | MS | Humana | 1200 | sbVerifiedFood | FILLED |
| H1036-330 | CSNP | MS | Humana | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1416-34 | DSNP | MS | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1416-44 | DSNP | MS | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H1416-81 | DSNP | MS | Wellcare | 864 | foodCardAllowance | FILLED |
| H1889-11 | DSNP | MS | UHC | 0 | $0 | UNVERIFIED-retry |
| H1889-32 | DSNP | MS | UHC | 0 | $0 | UNVERIFIED-retry |
| H3239-12 | DSNP | MS | Aetna | 480 | foodCardAllowance | FILLED |
| H3239-15 | DSNP | MS | Aetna | 30 | ssbciFood(PBP) | FILLED |
| H3239-28 | DSNP | MS | Aetna | 2388 | foodCardAllowance | FILLED |
| H3239-5 | DSNP | MS | Aetna | 1500 | foodCardAllowance | FILLED |
| H4407-29 | DSNP | MS | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H4407-34 | CSNP | MS | HealthSpring | 500 | foodCardAllowance | FILLED |
| H4407-4 | DSNP | MS | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H5008-11 | DSNP | MS | UHC | 0 | $0 | UNVERIFIED-retry |
| H5008-16 | DSNP | MS | UHC | 0 | $0 | UNVERIFIED-retry |
| H5008-17 | DSNP | MS | UHC | 0 | $0 | UNVERIFIED-retry |
| H5216-292 | DSNP | MS | Humana | 1200 | sbVerifiedFood | FILLED |
| H5216-298 | DSNP | MS | Humana | 1200 | sbVerifiedFood | FILLED |
| H5216-334 | CSNP | MS | Humana | 0 | $0 | UNVERIFIED-retry |
| H5216-367 | DSNP | MS | Humana | 2700 | sbVerifiedFood | FILLED |
| H5253-183 | CSNP | MS | UHC | 780 | sbVerifiedFood | FILLED |
| H5521-464 | DSNP | MS | Aetna | 840 | foodCardAllowance | FILLED |
| H5521-465 | DSNP | MS | Aetna | 480 | foodCardAllowance | FILLED |
| H6622-48 | DSNP | MS | Humana | 1800 | sbVerifiedFood | FILLED |
| H7355-10 | CSNP | MS | Devoted | 341 | ssbciFood(PBP) | FILLED |
| H7355-3 | DSNP | MS | Devoted | 3180 | foodCardAllowance | FILLED |
| H7355-4 | DSNP | MS | Devoted | 115 | ssbciFood(PBP) | FILLED |
| H7355-6 | CSNP | MS | Devoted | 588 | foodCardAllowance | FILLED |
| H7355-7 | CSNP | MS | Devoted | 2280 | foodCardAllowance | FILLED |
| H7355-9 | DSNP | MS | Devoted | 3792 | foodCardAllowance | FILLED |
| H7617-82 | DSNP | MS | Humana | 1200 | sbVerifiedFood | FILLED |
| H7617-83 | DSNP | MS | Humana | 1200 | sbVerifiedFood | FILLED |
| H7617-84 | DSNP | MS | Humana | 2700 | sbVerifiedFood | FILLED |
| H0628-13 | DSNP | OH | Aetna | 2880 | foodCardAllowance | FILLED |
| H0628-31 | CSNP | OH | Aetna | 2700 | foodCardAllowance | FILLED |
| H0628-32 | CSNP | OH | Aetna | 2400 | foodCardAllowance | FILLED |
| H0628-33 | CSNP | OH | Aetna | 2400 | foodCardAllowance | FILLED |
| H0628-34 | CSNP | OH | Aetna | 2400 | foodCardAllowance | FILLED |
| H0628-35 | CSNP | OH | Aetna | 2700 | foodCardAllowance | FILLED |
| H0628-36 | CSNP | OH | Aetna | 480 | foodCardAllowance | FILLED |
| H0628-37 | CSNP | OH | Aetna | 480 | foodCardAllowance | FILLED |
| H0628-38 | CSNP | OH | Aetna | 480 | foodCardAllowance | FILLED |
| H0628-39 | CSNP | OH | Aetna | 480 | foodCardAllowance | FILLED |
| H0628-41 | DSNP | OH | Aetna | 1200 | foodCardAllowance | FILLED |
| H0672-15 | DSNP | OH | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H0672-18 | DSNP | OH | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H0908-1 | DSNP | OH | Wellcare | 1200 | foodCardAllowance | FILLED |
| H0908-6 | DSNP | OH | Wellcare | 1500 | foodCardAllowance | FILLED |
| H0908-7 | DSNP | OH | Wellcare | 0 | $0 | UNVERIFIED-retry |
| H0908-8 | DSNP | OH | Wellcare | 0 | $0 | UNVERIFIED-retry |
| H2001-58 | DSNP | OH | UHC | 1224 | sbVerifiedFood | FILLED |
| H2697-10 | DSNP | OH | Devoted | 3204 | sbVerifiedFood | FILLED |
| H2697-11 | DSNP | OH | Devoted | 1428 | sbVerifiedFood | FILLED |
| H2697-16 | CSNP | OH | Devoted | 4740 | sbVerifiedFood | FILLED |
| H2697-17 | CSNP | OH | Devoted | 2400 | sbVerifiedFood | FILLED |
| H2697-18 | CSNP | OH | Devoted | 2400 | sbVerifiedFood | FILLED |
| H2697-20 | CSNP | OH | Devoted | 2400 | sbVerifiedFood | FILLED |
| H4158-1 | DSNP | OH | Wellcare | 2580 | foodCardAllowance | FILLED |
| H5253-122 | DSNP | OH | UHC | 732 | sbVerifiedFood | FILLED |
| H5253-59 | DSNP | OH | UHC | 1596 | foodCardAllowance | FILLED |
| H5322-28 | DSNP | OH | UHC | 1392 | foodCardAllowance | FILLED |
| H5322-34 | DSNP | OH | UHC | 708 | foodCardAllowance | FILLED |
| H5525-46 | DSNP | OH | Humana | 1020 | sbVerifiedFood | FILLED |
| H6622-15 | DSNP | OH | Humana | 1200 | sbVerifiedFood | FILLED |
| H6622-87 | DSNP | OH | Humana | 2880 | sbVerifiedFood | FILLED |
| H2001-56 | DSNP | OK | UHC | 1572 | sbVerifiedFood | FILLED |
| H2845-10 | CSNP | OK | Devoted | 2316 | foodCardAllowance | FILLED |
| H2845-3 | DSNP | OK | Devoted | 268 | ssbciFood(PBP) | FILLED |
| H2845-8 | CSNP | OK | Devoted | 294 | ssbciFood(PBP) | FILLED |
| H2845-9 | CSNP | OK | Devoted | 2316 | foodCardAllowance | FILLED |
| H3288-53 | DSNP | OK | Aetna | 1620 | foodCardAllowance | FILLED |
| H4537-4 | DSNP | OK | Wellcare | 1464 | foodCardAllowance | FILLED |
| H5216-228 | DSNP | OK | Humana | 1200 | sbVerifiedFood | FILLED |
| H5216-331 | DSNP | OK | Humana | 2040 | sbVerifiedFood | FILLED |
| H5216-372 | CSNP | OK | Humana | 660 | sbVerifiedFood | FILLED |
| H5216-469 | DSNP | OK | Humana | 2700 | sbVerifiedFood | FILLED |
| H5253-175 | CSNP | OK | UHC | 480 | sbVerifiedFood | FILLED |
| H5253-176 | CSNP | OK | UHC | 660 | sbVerifiedFood | FILLED |
| H5322-31 | DSNP | OK | UHC | 0 | $0 | UNVERIFIED-retry |
| H5322-33 | DSNP | OK | UHC | 0 | $0 | UNVERIFIED-retry |
| H6622-71 | CSNP | OK | Humana | 420 | sbVerifiedFood | FILLED |
| H7617-76 | DSNP | OK | Humana | 2700 | sbVerifiedFood | FILLED |
| H7617-78 | CSNP | OK | Humana | 660 | sbVerifiedFood | FILLED |
| H1396-1 | DSNP | SC | Humana | 0 | $0 | UNVERIFIED-retry |
| H2001-32 | DSNP | SC | UHC | 2424 | sbVerifiedFood | FILLED |
| H2001-59 | DSNP | SC | UHC | 960 | sbVerifiedFood | FILLED |
| H2001-60 | CSNP | SC | UHC | 540 | sbVerifiedFood | FILLED |
| H2001-75 | DSNP | SC | UHC | 3132 | sbVerifiedFood | FILLED |
| H2001-76 | CSNP | SC | UHC | 1128 | sbVerifiedFood | FILLED |
| H3146-16 | DSNP | SC | Aetna | 1500 | foodCardAllowance | FILLED |
| H3146-23 | DSNP | SC | Aetna | 2400 | foodCardAllowance | FILLED |
| H3146-36 | CSNP | SC | Aetna | 1500 | foodCardAllowance | FILLED |
| H3146-38 | CSNP | SC | Aetna | 600 | foodCardAllowance | FILLED |
| H5216-244 | CSNP | SC | Humana | 660 | sbVerifiedFood | FILLED |
| H5216-277 | DSNP | SC | Humana | 2040 | sbVerifiedFood | FILLED |
| H5619-161 | CSNP | SC | Humana | 1140 | sbVerifiedFood | FILLED |
| H7028-4 | CSNP | SC | Devoted | 588 | sbVerifiedFood | FILLED |
| H7028-5 | CSNP | SC | Devoted | 2400 | sbVerifiedFood | FILLED |
| H7028-6 | CSNP | SC | Devoted | 374 | ssbciFood(PBP) | FILLED |
| H0251-2 | DSNP | TN | UHC | 0 | $0 | UNVERIFIED-retry |
| H0251-4 | DSNP | TN | UHC | 0 | $0 | UNVERIFIED-retry |
| H0251-8 | DSNP | TN | UHC | 0 | $0 | UNVERIFIED-retry |
| H1416-35 | DSNP | TN | Wellcare | 2076 | foodCardAllowance | FILLED |
| H4461-22 | DSNP | TN | Humana | 3360 | sbVerifiedFood | FILLED |
| H4461-38 | DSNP | TN | Humana | 1800 | sbVerifiedFood | FILLED |
| H4461-42 | CSNP | TN | Humana | 1380 | sbVerifiedFood | FILLED |
| H4513-34 | DSNP | TN | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H4513-97 | CSNP | TN | HealthSpring | 400 | foodCardAllowance | FILLED |
| H5253-193 | CSNP | TN | UHC | 1020 | sbVerifiedFood | FILLED |
| H5253-194 | CSNP | TN | UHC | 1200 | sbVerifiedFood | FILLED |
| H7605-16 | CSNP | TN | Devoted | 2352 | sbVerifiedFood | FILLED |
| H9231-16 | CSNP | TN | Devoted | 2400 | sbVerifiedFood | FILLED |
| H9231-17 | CSNP | TN | Devoted | 2400 | sbVerifiedFood | FILLED |
| H9231-18 | CSNP | TN | Devoted | 2400 | sbVerifiedFood | FILLED |
| H9231-19 | CSNP | TN | Devoted | 2400 | sbVerifiedFood | FILLED |
| H9231-20 | CSNP | TN | Devoted | 385 | ssbciFood(PBP) | FILLED |
| H0028-32 | DSNP | TX | Humana | 1260 | sbVerifiedFood | FILLED |
| H0028-36 | DSNP | TX | Humana | 1560 | sbVerifiedFood | FILLED |
| H0028-39 | CSNP | TX | Humana | 900 | sbVerifiedFood | FILLED |
| H0028-60 | CSNP | TX | Humana | 720 | sbVerifiedFood | FILLED |
| H0174-22 | DSNP | TX | Wellcare | 828 | foodCardAllowance | FILLED |
| H0174-23 | DSNP | TX | Wellcare | 1344 | foodCardAllowance | FILLED |
| H0174-24 | DSNP | TX | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H0174-25 | DSNP | TX | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H0174-26 | DSNP | TX | Wellcare | 1368 | foodCardAllowance | FILLED |
| H0174-4 | DSNP | TX | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H0174-6 | DSNP | TX | Wellcare | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H0609-52 | DSNP | TX | UHC | 720 | sbVerifiedFood | FILLED |
| H0609-58 | CSNP | TX | UHC | 0 | $0 | VERIFIED-$0 |
| H0609-62 | CSNP | TX | UHC | 600 | sbVerifiedFood | FILLED |
| H0609-65 | DSNP | TX | UHC | 600 | sbVerifiedFood | FILLED |
| H2406-50 | DSNP | TX | UHC | 720 | sbVerifiedFood | FILLED |
| H3868-1 | DSNP | TX | UHC | 2220 | foodCardAllowance | FILLED |
| H4461-66 | CSNP | TX | Humana | 900 | sbVerifiedFood | FILLED |
| H4461-67 | CSNP | TX | Humana | 720 | sbVerifiedFood | FILLED |
| H4461-68 | CSNP | TX | Humana | 420 | sbVerifiedFood | FILLED |
| H4461-69 | DSNP | TX | Humana | 1560 | sbVerifiedFood | FILLED |
| H4461-70 | DSNP | TX | Humana | 2580 | sbVerifiedFood | FILLED |
| H4461-71 | DSNP | TX | Humana | 1320 | sbVerifiedFood | FILLED |
| H4461-72 | DSNP | TX | Humana | 2400 | sbVerifiedFood | FILLED |
| H4513-27 | DSNP | TX | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H4513-60 | DSNP | TX | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H4513-75 | DSNP | TX | HealthSpring | 0 | OTC_SUPPRESS | VERIFIED-$0 (OTC-only) |
| H4513-98 | CSNP | TX | HealthSpring | 600 | foodCardAllowance | FILLED |
| H4514-15 | CSNP | TX | UHC | 624 | sbVerifiedFood | FILLED |
| H4514-16 | DSNP | TX | UHC | 780 | sbVerifiedFood | FILLED |
| H4514-18 | DSNP | TX | UHC | 528 | sbVerifiedFood | FILLED |
| H4514-21 | DSNP | TX | UHC | 2172 | sbVerifiedFood | FILLED |
| H4514-23 | DSNP | TX | UHC | 636 | sbVerifiedFood | FILLED |
| H4514-24 | DSNP | TX | UHC | 708 | sbVerifiedFood | FILLED |
| H4523-28 | DSNP | TX | Aetna | 1440 | foodCardAllowance | FILLED |
| H4523-29 | DSNP | TX | Aetna | 1620 | foodCardAllowance | FILLED |
| H4523-30 | DSNP | TX | Aetna | 1680 | foodCardAllowance | FILLED |
| H4523-34 | DSNP | TX | Aetna | 1920 | foodCardAllowance | FILLED |
| H4523-37 | CSNP | TX | Aetna | 360 | foodCardAllowance | FILLED |
| H4523-38 | CSNP | TX | Aetna | 360 | foodCardAllowance | FILLED |
| H4523-39 | CSNP | TX | Aetna | 1080 | foodCardAllowance | FILLED |
| H4523-41 | DSNP | TX | Aetna | 1080 | foodCardAllowance | FILLED |
| H4523-43 | DSNP | TX | Aetna | 900 | foodCardAllowance | FILLED |
| H4523-44 | DSNP | TX | Aetna | 1020 | foodCardAllowance | FILLED |
| H4527-15 | DSNP | TX | UHC | 720 | sbVerifiedFood | FILLED |
| H4527-3 | DSNP | TX | UHC | 600 | sbVerifiedFood | FILLED |
| H4527-39 | CSNP | TX | UHC | 480 | sbVerifiedFood | FILLED |
| H4527-40 | CSNP | TX | UHC | 576 | sbVerifiedFood | FILLED |
| H4527-41 | CSNP | TX | UHC | 600 | sbVerifiedFood | FILLED |
| H4527-42 | CSNP | TX | UHC | 588 | sbVerifiedFood | FILLED |
| H4527-54 | DSNP | TX | UHC | 1716 | sbVerifiedFood | FILLED |
| H4527-57 | DSNP | TX | UHC | 1188 | sbVerifiedFood | FILLED |
| H5322-25 | DSNP | TX | UHC | 1200 | foodCardAllowance | FILLED |
| H5322-26 | DSNP | TX | UHC | 0 | $0 | UNVERIFIED-retry |
| H5322-38 | DSNP | TX | UHC | 0 | $0 | UNVERIFIED-retry |
| H5322-46 | DSNP | TX | UHC | 1836 | foodCardAllowance | FILLED |
| H7993-10 | DSNP | TX | Devoted | 2016 | sbVerifiedFood | FILLED |
| H7993-12 | DSNP | TX | Devoted | 2316 | sbVerifiedFood | FILLED |
| H7993-15 | DSNP | TX | Devoted | 2088 | sbVerifiedFood | FILLED |
| H7993-17 | DSNP | TX | Devoted | 2400 | sbVerifiedFood | FILLED |
| H7993-23 | CSNP | TX | Devoted | 1260 | sbVerifiedFood | FILLED |
| H7993-24 | CSNP | TX | Devoted | 3600 | sbVerifiedFood | FILLED |
| H7993-27 | CSNP | TX | Devoted | 480 | sbVerifiedFood | FILLED |
| H7993-28 | CSNP | TX | Devoted | 2100 | sbVerifiedFood | FILLED |
| H7993-29 | CSNP | TX | Devoted | 5100 | sbVerifiedFood | FILLED |
| H7993-30 | CSNP | TX | Devoted | 1800 | sbVerifiedFood | FILLED |
| H7993-31 | CSNP | TX | Devoted | 4800 | sbVerifiedFood | FILLED |
| H7993-33 | CSNP | TX | Devoted | 4800 | sbVerifiedFood | FILLED |
| H7993-37 | DSNP | TX | Devoted | 3012 | sbVerifiedFood | FILLED |
| H7993-38 | DSNP | TX | Devoted | 4500 | sbVerifiedFood | FILLED |
| H7993-40 | DSNP | TX | Devoted | 4200 | sbVerifiedFood | FILLED |
| H7993-41 | DSNP | TX | Devoted | 4200 | sbVerifiedFood | FILLED |
| H7993-46 | CSNP | TX | Devoted | 780 | sbVerifiedFood | FILLED |
| H8597-1 | DSNP | TX | Aetna | 1440 | foodCardAllowance | FILLED |
| H8597-2 | DSNP | TX | Aetna | 840 | foodCardAllowance | FILLED |
| H8597-3 | DSNP | TX | Aetna | 720 | foodCardAllowance | FILLED |
| H0421-1 | DSNP | VA | UHC | 0 | $0 | UNVERIFIED-retry |
| H2445-1 | DSNP | VA | UHC | 4884 | foodCardAllowance | FILLED |
| H2445-2 | DSNP | VA | UHC | 0 | $0 | UNVERIFIED-retry |
| H2445-3 | DSNP | VA | UHC | 0 | $0 | UNVERIFIED-retry |
| H2445-4 | DSNP | VA | UHC | 732 | foodCardAllowance | FILLED |
| H2445-5 | DSNP | VA | UHC | 3000 | foodCardAllowance | FILLED |
| H2875-1 | DSNP | VA | Humana | 1000 | ssbciFood(PBP) | FILLED |
| H2875-2 | DSNP | VA | Humana | 1260 | sbVerifiedFood | FILLED |
| H2875-3 | DSNP | VA | Humana | 0 | $0 | UNVERIFIED-retry |
| H2875-4 | DSNP | VA | Humana | 1500 | sbVerifiedFood | FILLED |
| H2875-5 | DSNP | VA | Humana | 900 | sbVerifiedFood | FILLED |
| H2875-6 | DSNP | VA | Humana | 1080 | sbVerifiedFood | FILLED |
| H5253-195 | CSNP | VA | UHC | 528 | sbVerifiedFood | FILLED |
| H5253-196 | CSNP | VA | UHC | 948 | sbVerifiedFood | FILLED |
| H5253-197 | CSNP | VA | UHC | 540 | sbVerifiedFood | FILLED |
| H5619-145 | CSNP | VA | Humana | 600 | sbVerifiedFood | FILLED |
| H5619-46 | CSNP | VA | Humana | 420 | sbVerifiedFood | FILLED |
| H6622-84 | CSNP | VA | Humana | 540 | sbVerifiedFood | FILLED |
| H6994-10 | CSNP | VA | Devoted | 2400 | foodCardAllowance | FILLED |
| H6994-13 | CSNP | VA | Devoted | 2400 | foodCardAllowance | FILLED |
| H6994-3 | CSNP | VA | Devoted | 2400 | foodCardAllowance | FILLED |
| H6994-4 | CSNP | VA | Devoted | 5052 | foodCardAllowance | FILLED |
| H1692-5 | DSNP | WV | Aetna | 2100 | foodCardAllowance | FILLED |
| H2001-30 | DSNP | WV | UHC | 1272 | sbVerifiedFood | FILLED |
| H2001-61 | DSNP | WV | UHC | 1092 | sbVerifiedFood | FILLED |
| H2001-82 | DSNP | WV | UHC | 2304 | sbVerifiedFood | FILLED |
| H5216-220 | DSNP | WV | Humana | 1200 | sbVerifiedFood | FILLED |
| H5619-126 | DSNP | WV | Humana | 1200 | sbVerifiedFood | FILLED |
| H5619-162 | DSNP | WV | Humana | 1920 | sbVerifiedFood | FILLED |
| H5619-179 | DSNP | WV | Humana | 2700 | sbVerifiedFood | FILLED |
