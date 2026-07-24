export type SubnetWindow = "7d" | "30d" | "90d";

export const SUBNET_WINDOWS: SubnetWindow[] = ["7d", "30d", "90d"];

export function isSubnetWindow(v: unknown): v is SubnetWindow {
  return v === "7d" || v === "30d" || v === "90d";
}
