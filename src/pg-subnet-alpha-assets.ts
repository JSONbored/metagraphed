// PostgreSQL implementation of the subnet-alpha-assets store (#13165): one
// bounded read of app.alpha_assets (migration 0049), the per-subnet alpha
// asset accounting the engine's AlphaAssets.TotalAlphaIssuance /
// AlphaAssets.AlphaBurned / AlphaAssets.AlphaRecycled decode fills. Amounts
// are u64 decimal text in their columns already; captured_at crosses as text
// because it is a bigint epoch-ms column and the driver would otherwise hand
// back a BigInt the JSON builders cannot serialize.
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { SubnetAlphaAssetsStore } from "./subnet-alpha-assets-store.ts";

/** The row the SELECT below produces, named so the read is drift-covered. */
type SubnetAlphaAssetsRow = {
  total_issuance: string | null;
  burned: string | null;
  recycled: string | null;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

export function createPgSubnetAlphaAssetsStore(
  runtime: Pick<PgStoreRuntime, "read">,
): SubnetAlphaAssetsStore {
  return {
    async latest(netuid: number) {
      // Same identity bound the routes enforce (a netuid is a u16); a store
      // must not widen it into a scan nothing can have asked for.
      if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535)
        throw new TypeError("Invalid native subnet alpha assets identity");
      return await runtime.read.query<SubnetAlphaAssetsRow>(
        "SELECT total_issuance, burned, recycled, " +
          "captured_at::text AS captured_at " +
          "FROM app.alpha_assets WHERE netuid=$1::bigint " +
          "ORDER BY captured_at DESC LIMIT 1",
        [netuid],
      );
    },
  };
}
