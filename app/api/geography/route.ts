import { getStates, getCountiesByState, getCountyByZip, find } from "us-zcta-counties";

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  MA: "Massachusetts", MD: "Maryland", ME: "Maine", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", PR: "Puerto Rico",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const state = searchParams.get("state");
  const county = searchParams.get("county");
  const zip = searchParams.get("zip");

  // Reverse lookup: zip → state + county
  if (zip) {
    const result = getCountyByZip(zip);
    if (result) {
      return Response.json({
        state: result.state,
        stateName: STATE_NAMES[result.state] || result.state,
        county: result.county,
      });
    }
    return Response.json({ state: null, county: null });
  }

  // Return all states
  if (!state) {
    const codes = getStates() as string[];
    const states = codes.map((code) => ({
      code,
      name: STATE_NAMES[code] || code,
    }));
    return Response.json({ states });
  }

  // Return counties for a state
  if (state && !county) {
    const counties = (getCountiesByState(state) as string[]) || [];
    return Response.json({ counties });
  }

  // Return zip codes for a state + county
  if (state && county) {
    const zips = (find({ state, county }) as string[]) || [];
    return Response.json({ zipCodes: zips });
  }

  return Response.json({ states: [], counties: [], zipCodes: [] });
}
