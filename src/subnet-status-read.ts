import { loadSubnetLifecycle } from "./subnet-lifecycle-read.ts";

/** Current lifecycle state for retained subnet cards; unavailable stays unknown. */
export async function loadSubnetStatus(
  env: unknown,
  netuid: number,
): Promise<"live" | "deregistered" | null> {
  const rows = await loadSubnetLifecycle(env, netuid, {
    limit: 1,
    offset: 0,
  }).catch(() => null);
  if (!rows?.[0]) return null;
  return rows[0].event === "deregistered" ? "deregistered" : "live";
}
