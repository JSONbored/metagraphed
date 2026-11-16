// PostgreSQL implementation of the subnet-swap store (#13165): one bounded
// read of app.swap_balancer (migration 0049), the per-subnet balancer AMM
// state the engine's Swap.BalancerTaoReservoir / Swap.BalancerAlphaReservoir
// / Swap.FeeRate decode fills. The reservoirs are u64 decimal text in their
// columns already; fee_rate is a raw u16 and crosses as int; captured_at
// crosses as text because it is a bigint epoch-ms column and the driver
// would otherwise hand back a BigInt the JSON builders cannot serialize.
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { SubnetSwapStore } from "./subnet-swap-store.ts";

/** The row the SELECT below produces, named so the read is drift-covered. */
type SubnetSwapRow = {
  tao_reservoir: string | null;
  alpha_reservoir: string | null;
  fee_rate: number | null;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

export function createPgSubnetSwapStore(
  runtime: Pick<PgStoreRuntime, "read">,
): SubnetSwapStore {
  return {
    async latest(netuid: number) {
      // Same identity bound the routes enforce (a netuid is a u16); a store
      // must not widen it into a scan nothing can have asked for.
      if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535)
        throw new TypeError("Invalid native subnet swap identity");
      return await runtime.read.query<SubnetSwapRow>(
        "SELECT tao_reservoir, alpha_reservoir, fee_rate::int AS fee_rate, " +
          "captured_at::text AS captured_at " +
          "FROM app.swap_balancer WHERE netuid=$1::bigint " +
          "ORDER BY captured_at DESC LIMIT 1",
        [netuid],
      );
    },
  };
}
