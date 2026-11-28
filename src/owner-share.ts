// A subnet's owner share now (MET-7385): its current declared split's owner
// slot, read from the state store (src/subnet-emission-store.ts). Since
// runtime 497 each subnet declares its own split, and the network's
// SubnetOwnerCut is only the default split's owner slot: on 2026-11-28, 22 of
// 131 subnets declared another share, from none at all (two) to 33% (nine).
// The owner-cut accrual and revenue coverage's owner take read it here.
//
// NULL IS THE DECLINE. With the store unbound or unreadable, no capture
// observed, or no current split for the subnet, the share is null and the
// figures built on it are too: a subnet's share is what the chain declares,
// not what the runtime would assume.
import { splitOfRow } from "./emission-split.ts";
import {
  selectedSubnetEmissionStore,
  type SubnetEmissionCurrent,
  type SubnetEmissionHistory,
} from "./subnet-emission-store.ts";

/** One subnet's current owner share from its validity ranges, or null. */
export function ownerShareOf(
  history: SubnetEmissionHistory | null | undefined,
): number | null {
  if (!history?.observation) return null;
  const current = history.splits.find((row) => row.valid_to === null);
  const split = current ? splitOfRow(current) : null;
  return split ? split.owner : null;
}

/** Every subnet's current owner share, by netuid; empty with no capture. */
export function ownerSharesOf(
  current: SubnetEmissionCurrent | null | undefined,
): Map<number, number> {
  const shares = new Map<number, number>();
  if (!current?.observation) return shares;
  for (const row of current.splits) {
    const split = row.valid_to === null ? splitOfRow(row) : null;
    if (split) shares.set(row.netuid, split.owner);
  }
  return shares;
}

/** One subnet's current owner share from the bound store, or null. */
export async function loadOwnerShare(
  env: unknown,
  netuid: number,
): Promise<number | null> {
  try {
    const store = selectedSubnetEmissionStore(env);
    return store ? ownerShareOf(await store.subnet(netuid)) : null;
  } catch (error) {
    console.error("subnet emission store read failed:", error);
    return null;
  }
}

/** Every subnet's current owner share from the bound store, in one read. */
export async function loadOwnerShares(
  env: unknown,
): Promise<Map<number, number>> {
  try {
    const store = selectedSubnetEmissionStore(env);
    return ownerSharesOf(store ? await store.current() : null);
  } catch (error) {
    console.error("subnet emission store read failed:", error);
    return new Map();
  }
}
