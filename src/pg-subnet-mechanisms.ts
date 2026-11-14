// PostgreSQL implementation of the subnet-mechanisms store (#13162): one
// bounded read of app.subnet_mechanisms (migration 0044), the registry the
// engine's MechanismCountCurrent / MechanismEmissionSplit /
// ConsensusByMechanism decode fills. captured_at crosses as text because it is
// a bigint epoch-ms column and the driver would otherwise hand back a BigInt
// the JSON builders cannot serialize.
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { SubnetMechanismsStore } from "./subnet-mechanisms-store.ts";

export function createPgSubnetMechanismsStore(
  runtime: Pick<PgStoreRuntime, "read">,
): SubnetMechanismsStore {
  return {
    async rows(netuid: number) {
      // Same identity bound the routes enforce (a netuid is a u16); a store
      // must not widen it into a scan nothing can have asked for.
      if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535)
        throw new TypeError("Invalid native subnet mechanisms identity");
      return await runtime.read.query<Record<string, unknown>>(
        "SELECT mechid::int AS mechid, emission_split, consensus_mode, " +
          "captured_at::text AS captured_at " +
          "FROM app.subnet_mechanisms WHERE netuid=$1::bigint ORDER BY mechid",
        [netuid],
      );
    },
  };
}
