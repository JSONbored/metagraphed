// PostgreSQL implementation of the child-keys store (#13166): bounded reads
// of app.childkey_takes / app.pending_child_keys / app.childkey_thresholds /
// app.child_keys_history (migration 0054), the child-key detail the engine's
// SubtensorModule.ChildkeyTake / PendingChildKeys / ChildkeyThresholdChecks /
// ChildkeyThresholdSuspended / ChildKeys decode fills. The bigint columns
// cross as text because the driver would otherwise hand back BigInts the
// JSON builders cannot serialize.
import { isFinneySs58Address } from "./finney-ss58.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { ChildKeysStore } from "./child-keys-store.ts";

/** The history bound: the newest captures answer "how did this relation
 * move" without an unbounded walk -- same cap discipline as
 * PENDING_COLDKEY_SWAPS_ROW_CAP. */
export const CHILD_KEYS_HISTORY_ROW_CAP = 512;

/** The row the take SELECT produces, named so the read is drift-covered. */
type ChildkeyTakeRow = {
  netuid: number;
  take: number;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

type PendingChildKeyRow = {
  netuid: number;
  child: string;
  proportion: string;
  /** bigint block height, crossed as text -- see the module header. */
  cool_down_block: string | null;
  captured_at: string;
};

type ChildkeyThresholdRow = {
  pending_check: boolean | null;
  suspended: boolean | null;
  captured_at: string;
};

type ChildKeysHistoryRow = {
  parent: string;
  netuid: number;
  child: string;
  proportion: string;
  captured_at: string;
};

function requireIdentity(value: string, what: string): void {
  // Same identity bound the routes enforce; a store must not widen a
  // malformed address into a scan nothing can have asked for.
  if (!isFinneySs58Address(value))
    throw new TypeError(`Invalid native ${what} identity`);
}

const HISTORY_COLUMNS =
  "parent, netuid::int AS netuid, child, proportion, " +
  "captured_at::text AS captured_at";

export function createPgChildKeysStore(
  runtime: Pick<PgStoreRuntime, "read">,
): ChildKeysStore {
  return {
    async takes(hotkey: string) {
      requireIdentity(hotkey, "childkey take");
      return await runtime.read.query<ChildkeyTakeRow>(
        "SELECT netuid::int AS netuid, take::int AS take, " +
          "captured_at::text AS captured_at " +
          "FROM app.childkey_takes WHERE hotkey=$1 ORDER BY netuid",
        [hotkey],
      );
    },
    async pending(parent: string) {
      requireIdentity(parent, "pending child keys");
      return await runtime.read.query<PendingChildKeyRow>(
        "SELECT netuid::int AS netuid, child, proportion, " +
          "cool_down_block::text AS cool_down_block, " +
          "captured_at::text AS captured_at " +
          "FROM app.pending_child_keys WHERE parent=$1 " +
          "ORDER BY netuid, child",
        [parent],
      );
    },
    async threshold(parent: string) {
      requireIdentity(parent, "childkey threshold");
      return await runtime.read.query<ChildkeyThresholdRow>(
        "SELECT pending_check, suspended, " +
          "captured_at::text AS captured_at " +
          "FROM app.childkey_thresholds WHERE parent=$1",
        [parent],
      );
    },
    async historyByParent(parent: string) {
      requireIdentity(parent, "child keys history");
      return await runtime.read.query<ChildKeysHistoryRow>(
        `SELECT ${HISTORY_COLUMNS} FROM app.child_keys_history ` +
          "WHERE parent=$1 ORDER BY captured_at DESC, netuid, child " +
          `LIMIT ${CHILD_KEYS_HISTORY_ROW_CAP}`,
        [parent],
      );
    },
    async historyByChild(child: string) {
      requireIdentity(child, "child keys history");
      return await runtime.read.query<ChildKeysHistoryRow>(
        `SELECT ${HISTORY_COLUMNS} FROM app.child_keys_history ` +
          "WHERE child=$1 ORDER BY captured_at DESC, netuid, parent " +
          `LIMIT ${CHILD_KEYS_HISTORY_ROW_CAP}`,
        [child],
      );
    },
  };
}
