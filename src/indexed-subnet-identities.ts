import type { AccountEventsRow } from "../generated/lakehouse/types.ts";
import type { ChainNetworkId } from "./chain-network.ts";
import { loadIndexedAccountFeedAggregate } from "./indexed-account-feeds.ts";

type Row = Record<string, unknown>;
export interface IdentitySpec {
  eventKind: string;
  countField: string;
  distinctField: string;
  distinctColumn: "hotkey" | "uid";
}

/** Read one complete subnet window; the page cap never changes its totals. */
export function loadIndexedSubnetIdentities(
  env: unknown,
  spec: IdentitySpec,
  netuid: number,
  cutoff: number,
  limit: number,
  network: ChainNetworkId,
) {
  return loadIndexedAccountFeedAggregate(
    env,
    [
      {
        side: "all",
        account: "*",
        kind: spec.eventKind,
        netuid,
        observedStart: cutoff,
      },
    ],
    (rows) => foldSubnetIdentities(rows, spec, limit),
    network,
  );
}

export async function foldSubnetIdentities(
  rows: AsyncIterable<AccountEventsRow>,
  spec: IdentitySpec,
  limit: number,
): Promise<{ rows: Row[]; totals: Row }> {
  const groups = new Map<string, Row>();
  let count = 0,
    newest: number | null = null;
  for await (const row of rows) {
    const key = JSON.stringify([row.netuid, row[spec.distinctColumn]]);
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= 100000)
        throw Error("Subnet participant budget exceeded");
      group = {
        netuid: row.netuid,
        [spec.distinctColumn]: row[spec.distinctColumn],
        [spec.countField]: 0,
        first_set: null,
        last_set: null,
      };
      groups.set(key, group);
    }
    group[spec.countField] = Number(group[spec.countField]) + 1;
    count++;
    if (row.observed_at !== null) {
      group.first_set =
        group.first_set === null
          ? row.observed_at
          : Math.min(Number(group.first_set), row.observed_at);
      group.last_set =
        group.last_set === null
          ? row.observed_at
          : Math.max(Number(group.last_set), row.observed_at);
      newest =
        newest === null ? row.observed_at : Math.max(newest, row.observed_at);
    }
  }
  return {
    rows: [...groups.values()]
      .sort((a, b) => Number(b[spec.countField]) - Number(a[spec.countField]))
      .slice(0, limit),
    totals: {
      [spec.countField]: count,
      [spec.distinctField]: groups.size,
      newest_observed: newest,
    },
  };
}
