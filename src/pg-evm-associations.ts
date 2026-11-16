// PostgreSQL implementation of the evm-associations store (#13165): one
// bounded read of app.evm_associations (migration 0051), the association
// history the engine's SubtensorModule.AssociatedEvmAddress decode fills
// (event EvmKeyAssociated). The bigint columns cross as text because the
// driver would otherwise hand back BigInts the JSON builders cannot
// serialize.
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { EvmAssociationsStore } from "./evm-associations-store.ts";

/** The hard row bound: one key's association history is small (one row per
 * re-association per (netuid, uid)), so one read is capped well above any
 * plausible depth. */
export const EVM_ASSOCIATIONS_ROW_CAP = 256;

/** The caller-side identity bound: the same H160 shape the route enforces,
 * lowercased by the caller before the read. */
const H160_LOWER_PATTERN = /^0x[0-9a-f]{40}$/;

/** The row the SELECT below produces, named so the read is drift-covered. */
type EvmAssociationRow = {
  ss58: string | null;
  netuid: number;
  uid: number;
  /** bigint block height, crossed as text -- see the module header. */
  associated_at: string | null;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

export function createPgEvmAssociationsStore(
  runtime: Pick<PgStoreRuntime, "read">,
): EvmAssociationsStore {
  return {
    async byH160(h160: string) {
      // Same identity bound the route enforces (a 20-byte 0x hex address,
      // lowercased); a store must not widen it into a scan nothing can have
      // asked for.
      if (typeof h160 !== "string" || !H160_LOWER_PATTERN.test(h160))
        throw new TypeError("Invalid native evm association identity");
      return await runtime.read.query<EvmAssociationRow>(
        "SELECT ss58, netuid::int AS netuid, uid::int AS uid, " +
          "associated_at::text AS associated_at, " +
          "captured_at::text AS captured_at " +
          "FROM app.evm_associations WHERE h160=$1 " +
          "ORDER BY captured_at DESC, netuid, uid " +
          `LIMIT ${EVM_ASSOCIATIONS_ROW_CAP}`,
        [h160],
      );
    },
  };
}
