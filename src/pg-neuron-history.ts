import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type {
  createSqliteDocumentDecoder,
  SqliteDocumentValue,
} from "./sqlite-document-decoder.ts";
import {
  projectAccountDocument,
  projectNeuronDocument,
} from "./neuron-document-projection.ts";
import type { NeuronHistoryStore } from "./neuron-history-store.ts";
import type {
  ColdAccountPositionRow,
  ColdNeuronHistoryRow,
} from "./neuron-daily-cold-tier.ts";
import type {
  ACCOUNT_POSITION_DAILY_COLUMNS,
  NEURON_DAILY_COLUMNS,
} from "../generated/lakehouse/types.ts";

const neuronFields = [
  "snapshot_date",
  "uid",
  "hotkey",
  "coldkey",
  "active",
  "validator_permit",
  "rank",
  "trust",
  "validator_trust",
  "consensus",
  "incentive",
  "dividends",
  "emission_tao",
  "stake_tao",
  "registered_at_block",
  "is_immunity_period",
  "axon",
  "block_number",
  "captured_at",
  "take",
] as const satisfies readonly (typeof NEURON_DAILY_COLUMNS)[number][];
const accountFields = [
  "snapshot_date",
  "captured_at",
  "uid",
  "coldkey",
  "active",
  "validator_permit",
  "rank",
  "trust",
  "incentive",
  "dividends",
  "stake_tao",
  "emission_tao",
] as const satisfies readonly (typeof ACCOUNT_POSITION_DAILY_COLUMNS)[number][];

interface MemberDocument {
  netuid: string;
  uid: string;
  hotkey: string | null;
  coldkey: string | null;
  snapshot_date: string;
  payload: Uint8Array;
}
interface AccountDocument {
  account: string;
  netuid: string;
  snapshot_date: string;
  payload: Uint8Array;
}

function sourceFields(
  row: Record<string, SqliteDocumentValue>,
  names: readonly string[],
) {
  return Object.fromEntries(
    names.map((name) => {
      const value = row[name];
      // D1's JSON boundary exposes SQLite INTEGER as a JS number. Keep that
      // existing conversion after the decoder's exact int64 extraction.
      return [name, typeof value === "bigint" ? Number(value) : value];
    }),
  );
}

function integerKey(value: number): string | null {
  if (!Number.isFinite(value) || !Number.isInteger(value))
    throw new TypeError("Invalid neuron history identity");
  const integer = BigInt(value);
  return integer < -(1n << 63n) || integer >= 1n << 63n
    ? null
    : integer.toString();
}

function validateLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new TypeError("Invalid neuron history limit");
}

/** These two callers select the original first-key SQL-view fields. Their
 * semantics differ from the subnet snapshot's JSON.parse last-key reader. */
export function createPgNeuronHistoryStore(
  runtime: Pick<PgStoreRuntime, "read">,
  decoder: ReturnType<typeof createSqliteDocumentDecoder>,
): NeuronHistoryStore {
  return {
    async neuronRows(netuid, uid, range, limit) {
      validateLimit(limit);
      const network = integerKey(netuid),
        slot = integerKey(uid);
      if (network === null || slot === null) return [];
      const rows = await runtime.read.query<MemberDocument>(
        `SELECT m.netuid::text,m.uid::text,m.hotkey,m.coldkey,m.snapshot_date,d.payload
         FROM app.neuron_daily_members m JOIN app.neuron_daily_documents d
           ON d.netuid=m.netuid AND d.day=m.snapshot_date AND d.shard=m.shard
         WHERE m.netuid=$1::bigint AND m.uid=$2::bigint
           AND ($3::text IS NULL OR m.snapshot_date >= $3::text COLLATE "C")
           AND ($4::text IS NULL OR m.snapshot_date < $4::text COLLATE "C")
         ORDER BY m.snapshot_date DESC LIMIT $5`,
        [network, slot, range.lo, range.hi, limit],
      );
      return rows.map(
        (row) =>
          sourceFields(
            projectNeuronDocument(
              decoder,
              {
                netuid: BigInt(row.netuid),
                uid: BigInt(row.uid),
                hotkey: row.hotkey,
                coldkey: row.coldkey,
                snapshot_date: row.snapshot_date,
              },
              row.payload,
            ),
            neuronFields,
          ) as ColdNeuronHistoryRow,
      );
    },
    async accountRows(account, netuid, range, limit) {
      validateLimit(limit);
      const network = integerKey(netuid);
      // Native account text cannot contain NUL; an unmatched public lookup
      // still returns an empty history instead of a PostgreSQL encoding error.
      if (network === null || account.includes("\0")) return [];
      const rows = await runtime.read.query<AccountDocument>(
        `SELECT m.account,m.netuid::text,m.snapshot_date,d.payload
         FROM app.account_position_daily_members m JOIN app.account_position_daily_documents d
           ON d.netuid=m.netuid AND d.day=m.snapshot_date AND d.shard=m.shard
         WHERE m.account=$1::text COLLATE "C" AND m.netuid=$2::bigint
           AND ($3::text IS NULL OR m.snapshot_date >= $3::text COLLATE "C")
           AND ($4::text IS NULL OR m.snapshot_date < $4::text COLLATE "C")
         ORDER BY m.snapshot_date DESC LIMIT $5`,
        [account, network, range.lo, range.hi, limit],
      );
      return rows.map(
        (row) =>
          sourceFields(
            projectAccountDocument(
              decoder,
              {
                account: row.account,
                netuid: BigInt(row.netuid),
                snapshot_date: row.snapshot_date,
              },
              row.payload,
            ),
            accountFields,
          ) as ColdAccountPositionRow,
      );
    },
  };
}
