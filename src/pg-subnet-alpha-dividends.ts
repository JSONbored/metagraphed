// PostgreSQL implementation of the subnet-alpha-dividends store (#13163): one
// bounded read of app.subnet_alpha_dividends (migration 0045), the accrual
// registry the engine's AlphaDividendsPerSubnet / RootAlphaDividendsPerSubnet
// decode fills. Amounts are u64 decimal text in the column already;
// captured_at crosses as text because it is a bigint epoch-ms column and the
// driver would otherwise hand back a BigInt the JSON builders cannot
// serialize.
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { SubnetAlphaDividendsStore } from "./subnet-alpha-dividends-store.ts";

/** The hard row bound: a subnet's dividend map is per-hotkey, so one read is
 * capped the same way the validator surfaces cap their hotkey scans. */
export const SUBNET_ALPHA_DIVIDENDS_ROW_CAP = 1024;

/** The row the SELECT below produces, named so the read is drift-covered. */
type SubnetAlphaDividendRow = {
  hotkey: string;
  alpha_divs: string | null;
  root_alpha_divs: string | null;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

export function createPgSubnetAlphaDividendsStore(
  runtime: Pick<PgStoreRuntime, "read">,
): SubnetAlphaDividendsStore {
  return {
    async rows(netuid: number) {
      // Same identity bound the routes enforce (a netuid is a u16); a store
      // must not widen it into a scan nothing can have asked for.
      if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535)
        throw new TypeError("Invalid native subnet alpha dividends identity");
      return await runtime.read.query<SubnetAlphaDividendRow>(
        "SELECT hotkey, alpha_divs, root_alpha_divs, " +
          "captured_at::text AS captured_at " +
          "FROM app.subnet_alpha_dividends WHERE netuid=$1::bigint " +
          "ORDER BY length(alpha_divs) DESC NULLS LAST, alpha_divs DESC NULLS LAST, hotkey " +
          `LIMIT ${SUBNET_ALPHA_DIVIDENDS_ROW_CAP}`,
        [netuid],
      );
    },
  };
}
