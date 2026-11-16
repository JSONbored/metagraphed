// PostgreSQL implementation of the coldkey-swaps store (#13166): bounded
// reads of app.coldkey_swap_announcements / app.coldkey_swap_policy /
// app.key_successors (migration 0053), the v2 swap state the engine's
// ColdkeySwapAnnouncements / ColdkeySwapDisputes /
// ColdkeySwapReservedDestination / ColdkeySwapV2PolicySnapshots decode and
// successor-lineage decode fill. The bigint columns cross as text because
// the driver would otherwise hand back BigInts the JSON builders cannot
// serialize.
import { isFinneySs58Address } from "./finney-ss58.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { ColdkeySwapsStore } from "./coldkey-swaps-store.ts";

/** The hard row bound on the chain-wide pending list: the chain map holds at
 * most one in-flight announcement per announcing account, so one request
 * carries the soonest-executable swaps rather than an unbounded scan -- same
 * cap discipline as GAMMA_DEPOSITS_ROW_CAP. */
export const PENDING_COLDKEY_SWAPS_ROW_CAP = 1024;

/** The per-key lineage bound: a key appears at most once per (kind, netuid),
 * so one read is capped well above any plausible subnet count. */
export const KEY_LINEAGE_ROW_CAP = 256;

/** The row the announcement SELECTs below produce, named so the reads are
 * drift-covered. */
type ColdkeySwapAnnouncementRow = {
  coldkey: string;
  new_coldkey: string | null;
  announcement_hash: string | null;
  /** bigint block heights, crossed as text -- see the module header. */
  announced_at: string | null;
  execute_at: string | null;
  disputed: boolean | null;
  disputed_at: string | null;
  policy_snapshot: boolean | null;
  status: string | null;
  /** bigint epoch-ms, crossed as text -- see the module header. */
  captured_at: string;
};

type ColdkeySwapPolicyRow = {
  announcement_delay: string | null;
  reannouncement_delay: string | null;
  captured_at: string;
};

type KeySuccessorRow = {
  kind: string;
  netuid: number | null;
  successor: string | null;
  root: string | null;
  captured_at: string;
};

const ANNOUNCEMENT_COLUMNS =
  "coldkey, new_coldkey, announcement_hash, " +
  "announced_at::text AS announced_at, execute_at::text AS execute_at, " +
  "disputed, disputed_at::text AS disputed_at, policy_snapshot, status, " +
  "captured_at::text AS captured_at";

export function createPgColdkeySwapsStore(
  runtime: Pick<PgStoreRuntime, "read">,
): ColdkeySwapsStore {
  return {
    async pending() {
      // Soonest-executable first, the order idx_coldkey_swap_announcements_
      // execute serves directly; an announcement without a carried execute
      // block sorts last rather than being dropped.
      return await runtime.read.query<ColdkeySwapAnnouncementRow>(
        `SELECT ${ANNOUNCEMENT_COLUMNS} FROM app.coldkey_swap_announcements ` +
          "ORDER BY execute_at NULLS LAST, coldkey " +
          `LIMIT ${PENDING_COLDKEY_SWAPS_ROW_CAP}`,
      );
    },
    async announcement(coldkey: string) {
      // Same identity bound the routes enforce; a store must not widen a
      // malformed address into a scan nothing can have asked for.
      if (!isFinneySs58Address(coldkey))
        throw new TypeError("Invalid native coldkey swap identity");
      return await runtime.read.query<ColdkeySwapAnnouncementRow>(
        `SELECT ${ANNOUNCEMENT_COLUMNS} FROM app.coldkey_swap_announcements ` +
          "WHERE coldkey=$1",
        [coldkey],
      );
    },
    async policy() {
      return await runtime.read.query<ColdkeySwapPolicyRow>(
        "SELECT announcement_delay::text AS announcement_delay, " +
          "reannouncement_delay::text AS reannouncement_delay, " +
          "captured_at::text AS captured_at " +
          "FROM app.coldkey_swap_policy ORDER BY captured_at DESC LIMIT 1",
      );
    },
    async lineage(key: string) {
      if (!isFinneySs58Address(key))
        throw new TypeError("Invalid native key lineage identity");
      return await runtime.read.query<KeySuccessorRow>(
        "SELECT kind, netuid::int AS netuid, successor, root, " +
          "captured_at::text AS captured_at " +
          "FROM app.key_successors WHERE key=$1 " +
          "ORDER BY kind, netuid NULLS FIRST " +
          `LIMIT ${KEY_LINEAGE_ROW_CAP}`,
        [key],
      );
    },
  };
}
