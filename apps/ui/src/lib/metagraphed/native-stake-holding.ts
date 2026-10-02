import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { getApiBase } from "./config";
import { metagraphedQueryKey } from "./queries";
import { accountHex, type NativeArtifact, type NativeOperation } from "./native-runtime";
import { asRao, asRawAlpha, rawAlphaToAlpha, raoToTao, UNITS_PER_WHOLE } from "./units";

export interface NativeStakeHolding {
  source: NativeArtifact["source"];
  stakeAtomic: bigint;
  availableAtomic: bigint;
  priceAtomic: bigint;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("The runtime returned an invalid stake holding.");
  return value as Record<string, unknown>;
}
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) >= 1n << 64n)
    throw new Error("The runtime returned an invalid stake quantity.");
  return BigInt(value);
}
export function decodeNativeStakeHolding(artifact: NativeArtifact, hotkey: string, coldkey: string, netuid: number): NativeStakeHolding {
  const hot = accountHex(hotkey), cold = accountHex(coldkey);
  const info = artifact.results[0], availability = artifact.results[1], price = artifact.results[2], collateral = artifact.results[3];
  if (info?.api !== "StakeInfoRuntimeApi" || info.member !== "get_stake_info_for_hotkey_coldkey_netuid" || availability?.api !== "StakeInfoRuntimeApi" || availability.member !== "get_stake_availability_for_coldkeys" || price?.api !== "SwapRuntimeApi" || price.member !== "current_alpha_price")
    throw new Error("The stake response does not match the requested holding.");
  if (collateral?.kind !== "storage" || collateral.pallet !== "SubtensorModule" || collateral.member !== "MinerCollateral")
    throw new Error("The stake response does not include the position's miner collateral.");
  const bonded = collateral.value === null ? 0n : quantity(record(collateral.value).locked);
  const optional = record(info.value);
  let stake = 0n;
  if (optional.variant === "Some") {
    const row = record(optional.fields);
    if (row.hotkey !== hot || row.coldkey !== cold || quantity(row.netuid) !== BigInt(netuid))
      throw new Error("The stake response belongs to another account or subnet.");
    stake = quantity(row.stake);
  } else if (optional.variant !== "None") throw new Error("Invalid stake option.");
  let available = 0n;
  if (!Array.isArray(availability.value)) throw new Error("Invalid stake availability map.");
  for (const account of availability.value) {
    if (!Array.isArray(account) || account.length !== 2 || account[0] !== cold || !Array.isArray(account[1]))
      throw new Error("Invalid stake availability account.");
    for (const subnet of account[1]) {
      if (!Array.isArray(subnet) || subnet.length !== 2 || quantity(subnet[0]) !== BigInt(netuid))
        throw new Error("Invalid stake availability subnet.");
      const row = record(subnet[1]);
      const total = quantity(row.total), locked = quantity(row.locked), free = quantity(row.available);
      if (free > (total > locked ? total - locked : 0n)) throw new Error("Inconsistent stake availability.");
      available = free;
    }
  }
  const positionFree = stake > bonded ? stake - bonded : 0n;
  return { source: artifact.source, stakeAtomic: stake, availableAtomic: available < positionFree ? available : positionFree, priceAtomic: quantity(price.value) };
}

export function nativeUnstakeMax(holding: NativeStakeHolding | null, unit: "tao" | "alpha"): string | null {
  if (!holding) return null;
  if (unit === "alpha") return rawAlphaToAlpha(asRawAlpha(holding.availableAtomic));
  if (holding.priceAtomic === 0n) return null;
  // TAO mode is a target estimate. Its exact ceil conversion must never select
  // more alpha than the bounded holding; the ensuing simulator supplies output.
  return raoToTao(asRao(holding.availableAtomic * holding.priceAtomic / UNITS_PER_WHOLE));
}

export const nativeStakeHoldingQuery = (hotkey: string, coldkey: string | null, netuid: number) => queryOptions({
  queryKey: metagraphedQueryKey("native-stake-holding", getApiBase(), hotkey, coldkey, netuid),
  enabled: coldkey !== null,
  retry: 0,
  staleTime: 15_000,
  queryFn: async ({ signal }) => {
    const hot = accountHex(hotkey), cold = accountHex(coldkey!);
    const operations: NativeOperation[] = [
      { kind: "runtime", api: "StakeInfoRuntimeApi", member: "get_stake_info_for_hotkey_coldkey_netuid", args: [hot, cold, netuid] },
      { kind: "runtime", api: "StakeInfoRuntimeApi", member: "get_stake_availability_for_coldkeys", args: [[cold], { variant: "Some", fields: [netuid] }] },
      { kind: "runtime", api: "SwapRuntimeApi", member: "current_alpha_price", args: [netuid] },
      { kind: "storage", pallet: "SubtensorModule", member: "MinerCollateral", args: [netuid, hot, cold] },
    ];
    const response = await apiFetch<NativeArtifact>("/api/v1/native-runtime", { signal, init: { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ operations }) } });
    return decodeNativeStakeHolding(response.data, hot, cold, netuid);
  },
});
