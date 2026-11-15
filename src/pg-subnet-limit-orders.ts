// PostgreSQL implementation of the subnet-limit-orders store (#13165): one
// bounded read of app.limit_orders (migration 0050), the order book the
// engine's LimitOrders.Orders / LimitOrders.ApprovedOrders decode fills.
// Amounts and prices are decimal text in their columns already; captured_at
// crosses as text because it is a bigint epoch-ms column and the driver
// would otherwise hand back a BigInt the JSON builders cannot serialize.
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { SubnetLimitOrdersStore } from "./subnet-limit-orders-store.ts";

/** The hard row bound: a subnet's order book is per-order, so one read is
 * capped the same way the dividend surfaces cap their hotkey scans. */
export const SUBNET_LIMIT_ORDERS_ROW_CAP = 1024;

/** The row the SELECT below produces, named so the read is drift-covered. */
type SubnetLimitOrderRow = {
  order_id: string;
  owner: string;
  kind: string;
  amount: string | null;
  price: string | null;
  status: string | null;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

export function createPgSubnetLimitOrdersStore(
  runtime: Pick<PgStoreRuntime, "read">,
): SubnetLimitOrdersStore {
  return {
    async rows(netuid: number) {
      // Same identity bound the routes enforce (a netuid is a u16); a store
      // must not widen it into a scan nothing can have asked for.
      if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535)
        throw new TypeError("Invalid native subnet limit orders identity");
      return await runtime.read.query<SubnetLimitOrderRow>(
        "SELECT order_id, owner, kind, amount, price, status, " +
          "captured_at::text AS captured_at " +
          "FROM app.limit_orders WHERE netuid=$1::bigint " +
          "ORDER BY captured_at DESC, order_id " +
          `LIMIT ${SUBNET_LIMIT_ORDERS_ROW_CAP}`,
        [netuid],
      );
    },
  };
}
