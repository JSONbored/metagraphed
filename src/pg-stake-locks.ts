// PostgreSQL implementation of the account-locks store (#13163): one bounded
// read of app.stake_locks (migration 0045), the conviction-lock state the
// engine's Lock / HotkeyLock / DecayingLock / OwnerLock decode fills. amount
// is u64 decimal text in the column already; the bigint columns cross as text
// because the driver would otherwise hand back BigInts the JSON builders
// cannot serialize.
import { isFinneySs58Address } from "./finney-ss58.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { AccountLocksStore } from "./account-locks-store.ts";

/** The row the SELECT below produces, named so the read is drift-covered. */
type StakeLockRow = {
  hotkey: string;
  netuid: number;
  kind: string;
  amount: string;
  /** bigint block height, crossed as text -- see the module header. */
  maturity_block: string | null;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

export function createPgAccountLocksStore(
  runtime: Pick<PgStoreRuntime, "read">,
): AccountLocksStore {
  return {
    async rows(coldkey: string) {
      // Same identity bound the routes enforce; a store must not widen a
      // malformed address into a scan nothing can have asked for.
      if (!isFinneySs58Address(coldkey))
        throw new TypeError("Invalid native account locks identity");
      return await runtime.read.query<StakeLockRow>(
        "SELECT hotkey, netuid::int AS netuid, kind, amount, " +
          "maturity_block::text AS maturity_block, " +
          "captured_at::text AS captured_at " +
          "FROM app.stake_locks WHERE coldkey=$1 " +
          "ORDER BY netuid, hotkey, kind",
        [coldkey],
      );
    },
  };
}
