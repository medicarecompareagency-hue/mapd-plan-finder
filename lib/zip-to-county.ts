// lib/zip-to-county.ts
// ZIP → county lookup via us-zcta-counties (same package used by /api/geography).
// Returns county with the suffix that package uses (e.g. "Shelby County").
// The /api/plans handler normalizes suffixes, so pass the raw value through.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getCountyByZip } = require("us-zcta-counties") as {
  getCountyByZip: (zip: string) => { state: string; county: string } | undefined;
};

export function zipToCounty(zip: string): { county: string; state: string } | null {
  const normalized = zip.trim().padStart(5, "0");
  const result = getCountyByZip(normalized);
  if (!result) return null;
  return { county: result.county, state: result.state };
}
