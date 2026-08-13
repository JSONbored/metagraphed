// DELIBERATELY literal, not derived from one route (#10994): the subnet
// page's shared window control drives several routes at once (stake-flow,
// event summary, movers, ...), each of which owns its window set separately
// -- ten routes coincide on these three by choice, and the schema tree pins
// that coincidence rather than coupling them. Deriving this from any single
// route would encode a lineage that does not exist; if one route ever
// diverges, the control must split per panel, not silently follow one route.
export type SubnetWindow = "7d" | "30d" | "90d";

export const SUBNET_WINDOWS: SubnetWindow[] = ["7d", "30d", "90d"];

export function isSubnetWindow(v: unknown): v is SubnetWindow {
  return v === "7d" || v === "30d" || v === "90d";
}
