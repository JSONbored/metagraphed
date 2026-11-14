// PostgreSQL implementation of the tao-usd-oracle store (#13164): one bounded
// read of app.tao_usd_oracle (migration 0048), the on-chain feed history the
// engine's TaoUsdPrice / TaoUsdPriceOracle / TaoUsdPriceFed decode fills.
// price_raw is canonical decimal text in the column already; the bigint
// columns cross as text because the driver would otherwise hand back BigInts
// the JSON builders cannot serialize.
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { TaoUsdOracleStore } from "./tao-usd-oracle-store.ts";

/** The hard row bound: the oracle block carries the newest feeds, not the
 * whole history -- same cap discipline as SUBNET_GAMMA_HISTORY_ROW_CAP. The
 * feed cadence is the chain's to set, so the serving tier caps what one
 * request can carry rather than trusting the writer to stay sparse. */
export const TAO_USD_ORACLE_ROW_CAP = 1024;

/** The row the SELECT below produces, named so the read is drift-covered. */
type TaoUsdOracleRow = {
  /** bigint block height, crossed as text -- see the module header. */
  block_number: string;
  usd_per_tao: number | null;
  price_raw: string | null;
  oracle: string | null;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  observed_at: string;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

export function createPgTaoUsdOracleStore(
  runtime: Pick<PgStoreRuntime, "read">,
): TaoUsdOracleStore {
  return {
    async rows() {
      return await runtime.read.query<TaoUsdOracleRow>(
        "SELECT block_number::text AS block_number, usd_per_tao, price_raw, " +
          "oracle, observed_at::text AS observed_at, " +
          "captured_at::text AS captured_at " +
          "FROM app.tao_usd_oracle ORDER BY block_number DESC " +
          `LIMIT ${TAO_USD_ORACLE_ROW_CAP}`,
      );
    },
  };
}
