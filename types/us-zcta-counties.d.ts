declare module "us-zcta-counties" {
  export function getStates(): string[];
  export function getCountiesByState(state: string): string[];
  export function getCountyByZip(zip: string): { state: string; county: string } | null;
  export function find(query: { state: string; county: string }): string[] | null;
}
