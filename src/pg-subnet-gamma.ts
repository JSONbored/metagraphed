// PostgreSQL implementation of the subnet-gamma store (#13164): bounded
// reads of app.subnet_gamma and app.chain_gamma (migration 0047), the Gamma
// state the engine's SubnetGammaEnabled / SubnetGammaPrice /
// SubnetGammaEmission / PendingGammaEmission / UnconvertedGammaEmission /
// SubnetGammaEmissionWhitelisted / GammaEnabled decode fills. Quantities are
// canonical decimal text in the columns already; captured_at crosses as text
// because it is a bigint epoch-ms column and the driver would otherwise hand
// back a BigInt the JSON builders cannot serialize.
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { SubnetGammaStore } from "./subnet-gamma-store.ts";

/** The hard row bound on the per-subnet history read: the capture cadence is
 * the engine's to set, so the serving tier caps what one request can carry
 * rather than trusting the writer to stay sparse. */
export const SUBNET_GAMMA_HISTORY_ROW_CAP = 1024;

/** The hard row bound on the chain-wide read: one row per subnet, and the
 * chain holds a few hundred subnets, so this is headroom rather than a
 * truncation anyone should observe. */
export const CHAIN_GAMMA_ROW_CAP = 1024;

/** The row the per-subnet SELECTs below produce, named so the reads are
 * drift-covered. */
type SubnetGammaRow = {
  enabled: boolean | null;
  price: string | null;
  emission: string | null;
  pending_emission: string | null;
  unconverted_emission: string | null;
  whitelisted: boolean | null;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

/** The chain-wide row: the per-subnet shape plus its netuid key. */
type ChainGammaSubnetRow = SubnetGammaRow & { netuid: number };

/** The global GammaEnabled row the enabled() SELECT produces. */
type ChainGammaRow = {
  enabled: boolean;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

const SUBNET_GAMMA_COLUMNS =
  "enabled, price, emission, pending_emission, unconverted_emission, " +
  "whitelisted, captured_at::text AS captured_at";

function assertNetuid(netuid: number): void {
  // Same identity bound the routes enforce (a netuid is a u16); a store must
  // not widen it into a scan nothing can have asked for.
  if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535)
    throw new TypeError("Invalid native subnet gamma identity");
}

export function createPgSubnetGammaStore(
  runtime: Pick<PgStoreRuntime, "read">,
): SubnetGammaStore {
  return {
    async latest(netuid: number) {
      assertNetuid(netuid);
      return await runtime.read.query<SubnetGammaRow>(
        `SELECT ${SUBNET_GAMMA_COLUMNS} FROM app.subnet_gamma ` +
          "WHERE netuid=$1::bigint ORDER BY captured_at DESC LIMIT 1",
        [netuid],
      );
    },
    async history(netuid: number) {
      assertNetuid(netuid);
      return await runtime.read.query<SubnetGammaRow>(
        `SELECT ${SUBNET_GAMMA_COLUMNS} FROM app.subnet_gamma ` +
          "WHERE netuid=$1::bigint ORDER BY captured_at DESC " +
          `LIMIT ${SUBNET_GAMMA_HISTORY_ROW_CAP}`,
        [netuid],
      );
    },
    async chain() {
      // DISTINCT ON picks the newest capture per netuid in one pass -- the
      // primary key (netuid, captured_at) makes both the dedup and the order
      // an index walk, not a sort.
      return await runtime.read.query<ChainGammaSubnetRow>(
        "SELECT DISTINCT ON (netuid) netuid::int AS netuid, " +
          `${SUBNET_GAMMA_COLUMNS} FROM app.subnet_gamma ` +
          "ORDER BY netuid, captured_at DESC " +
          `LIMIT ${CHAIN_GAMMA_ROW_CAP}`,
      );
    },
    async enabled() {
      return await runtime.read.query<ChainGammaRow>(
        "SELECT enabled, captured_at::text AS captured_at " +
          "FROM app.chain_gamma ORDER BY captured_at DESC LIMIT 1",
      );
    },
  };
}
