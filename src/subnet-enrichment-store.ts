import type {
  ComputeDeclarations,
  NominatorPositions,
  TreasuryReadings,
} from "../generated/db/types.ts";

export interface SubnetEnrichmentStore {
  dailyRows(
    netuid: number,
    cutoff: string,
    kind: "emission" | "owner",
    limit: number,
  ): Promise<Record<string, unknown>[]>;
  ownerColdkey(netuid: number): Promise<string | null>;
  ownerPositions(
    netuid: number,
  ): Promise<
    Pick<NominatorPositions, "coldkey" | "hotkey" | "share_fraction">[]
  >;
  declarations(netuid: number): Promise<ComputeDeclarations[]>;
  treasury(netuid: number): Promise<TreasuryReadings[]>;
  usdDays(
    cutoffMs: number,
    lastDayMs: number,
  ): Promise<
    { observed_at: number | string | null; usd_per_tao: number | null }[]
  >;
}

export function selectedSubnetEnrichmentStore(
  env: unknown,
): SubnetEnrichmentStore | null {
  if (!env || typeof env !== "object" || !("SUBNET_ENRICHMENT_STORE" in env))
    return null;
  const store = env.SUBNET_ENRICHMENT_STORE;
  if (
    !store ||
    typeof store !== "object" ||
    ![
      "dailyRows",
      "ownerColdkey",
      "ownerPositions",
      "declarations",
      "treasury",
      "usdDays",
    ].every(
      (name) => typeof (store as Record<string, unknown>)[name] === "function",
    )
  )
    throw new TypeError("Invalid native subnet enrichment store");
  return store as SubnetEnrichmentStore;
}
