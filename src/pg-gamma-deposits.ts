// PostgreSQL implementation of the gamma-deposits store (#13164): one
// bounded read of app.gamma_deposits (migration 0047), the deposit state the
// engine's GammaDeposits decode fills. balance / daily_cap are u64 decimal
// text in the columns already; the bigint columns cross as text because the
// driver would otherwise hand back BigInts the JSON builders cannot
// serialize.
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { GammaDepositsStore } from "./gamma-deposits-store.ts";

/** The hard row bound: the chain-wide card is a leaderboard-shaped read, so
 * one request carries the largest deposits rather than an unbounded scan --
 * same cap discipline as SUBNET_ALPHA_DIVIDENDS_ROW_CAP. */
export const GAMMA_DEPOSITS_ROW_CAP = 1024;

/** The row the SELECT below produces, named so the read is drift-covered. */
type GammaDepositRow = {
  coldkey: string;
  hotkey: string;
  netuid: number;
  balance: string;
  spender: string | null;
  daily_cap: string | null;
  /** bigint block height, crossed as text -- see the module header. */
  closed_at: string | null;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

export function createPgGammaDepositsStore(
  runtime: Pick<PgStoreRuntime, "read">,
): GammaDepositsStore {
  return {
    async rows() {
      // Largest balance first, as (digit count, text) -- the canonical
      // decimal-text ordering idx_gamma_deposits_balance serves directly.
      return await runtime.read.query<GammaDepositRow>(
        "SELECT coldkey, hotkey, netuid::int AS netuid, balance, spender, " +
          "daily_cap, closed_at::text AS closed_at, " +
          "captured_at::text AS captured_at " +
          "FROM app.gamma_deposits " +
          "ORDER BY length(balance) DESC, balance DESC, coldkey, hotkey, netuid " +
          `LIMIT ${GAMMA_DEPOSITS_ROW_CAP}`,
      );
    },
  };
}
