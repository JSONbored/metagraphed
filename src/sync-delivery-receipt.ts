// Business delivery receipts for the existing pass-tallied bulk lanes.
// Transport message IDs and successful row UPSERTs are not delivery evidence.
import { createHash } from "node:crypto";
import type { PassTallyInput } from "./pass-completeness.ts";
import { PASS_TABLES } from "./pass-completeness.ts";
import type { ProducerStatement, ProducerStore } from "./producer-store.ts";

type Row = Record<string, unknown>;
export interface SyncDelivery {
  version: 1;
  id: string;
  sha256: string;
  parent_id?: string;
  parent_sha256?: string;
}

const KEYS: Readonly<Record<string, readonly string[]>> = {
  "account-balances": ["ss58"],
  "hotkey-alpha": ["hotkey", "netuid"],
  "validator-nominator-counts": ["hotkey"],
  "nominator-positions": ["coldkey", "hotkey", "netuid"],
  neurons: ["netuid", "uid"],
};

/** Versioned binary encoding shared with the Rust producer. IEEE754 bytes
 * avoid JSON's different spellings of 1/1.0, exponents and negative zero.
 * Lengths count UTF8 bytes. Object keys are ASCII schema column names.
 * Booleans normalize to the numeric cells the native writers store. */
export function syncDeliveryBytes(value: unknown): Buffer {
  if (value === null || value === undefined) return Buffer.from("z");
  if (typeof value === "boolean") return syncDeliveryBytes(Number(value));
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Non-finite delivery cell");
    const out = Buffer.alloc(9);
    out[0] = 110;
    out.writeDoubleBE(value === 0 ? 0 : value, 1);
    return out;
  }
  const length = (tag: string, size: number) => {
    const head = Buffer.alloc(5);
    head[0] = tag.charCodeAt(0);
    head.writeUInt32BE(size, 1);
    return head;
  };
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    // Rust strings are valid UTF8. Reject lone JS surrogates rather than hash
    // their replacement character as if it were the original payload.
    if (bytes.toString("utf8") !== value)
      throw new TypeError("Delivery strings must be valid Unicode");
    return Buffer.concat([length("s", bytes.length), bytes]);
  }
  if (Array.isArray(value))
    return Buffer.concat([
      length("a", value.length),
      ...value.map(syncDeliveryBytes),
    ]);
  if (typeof value === "object") {
    const entries = Object.entries(value as Row)
      .filter(([, cell]) => cell !== null && cell !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    if (entries.some(([key]) => !/^[a-z0-9_]+$/.test(key)))
      throw new TypeError("Delivery object keys must be schema columns");
    return Buffer.concat([
      length("o", entries.length),
      ...entries.flatMap(([key, cell]) => [
        syncDeliveryBytes(key),
        syncDeliveryBytes(cell),
      ]),
    ]);
  }
  throw new TypeError("Unsupported delivery cell");
}

const digest = (value: unknown) =>
  createHash("sha256").update(syncDeliveryBytes(value)).digest("hex");

export function syncDeliveryKey(lane: string, row: Row): string {
  const keys = KEYS[lane];
  if (!keys || keys.some((key) => row[key] == null))
    throw new TypeError("Unknown delivery lane or missing business key");
  return syncDeliveryBytes(keys.map((key) => row[key])).toString("hex");
}

/** Producer chunks must be consecutive slices of a globally sorted, unique
 * scan. The receiver verifies order and rejects intersecting key intervals. */
export function makeSyncDelivery(
  lane: string,
  capturedAt: number,
  total: number,
  rows: readonly Row[],
  parent?: SyncDelivery,
): SyncDelivery {
  const keys = rows.map((row) => syncDeliveryKey(lane, row));
  if (
    !Number.isSafeInteger(capturedAt) ||
    capturedAt < 1e12 ||
    !Number.isSafeInteger(total) ||
    total < rows.length ||
    !rows.length ||
    rows.some((row) => row.captured_at !== capturedAt) ||
    keys.some((key, index) => index > 0 && keys[index - 1]! >= key)
  )
    throw new TypeError(
      "Delivery needs one ordered, unique capture and census",
    );
  const identity = ["metagraph-sync-delivery", 1, lane, capturedAt, total];
  return {
    version: 1,
    id: digest([...identity, keys]),
    sha256: digest([...identity, rows]),
    ...(parent
      ? {
          parent_id: parent.parent_id ?? parent.id,
          parent_sha256: parent.parent_sha256 ?? parent.sha256,
        }
      : {}),
  };
}

export function validSyncDelivery(value: unknown): value is SyncDelivery {
  if (!value || typeof value !== "object") return false;
  const d = value as SyncDelivery;
  const hash = (v: unknown) =>
    typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
  return (
    d.version === 1 &&
    hash(d.id) &&
    hash(d.sha256) &&
    Object.keys(d).every((key) =>
      ["version", "id", "sha256", "parent_id", "parent_sha256"].includes(key),
    ) &&
    ((d.parent_id === undefined && d.parent_sha256 === undefined) ||
      (hash(d.parent_id) && hash(d.parent_sha256)))
  );
}

export function verifySyncDelivery(
  value: unknown,
  lane: string,
  pass: PassTallyInput,
  rows: readonly Row[],
): asserts value is SyncDelivery {
  if (!validSyncDelivery(value))
    throw new TypeError("Invalid business delivery envelope");
  const expected = makeSyncDelivery(
    lane,
    pass.capturedAt,
    pass.expectedRows,
    rows,
  );
  if (
    value.id !== expected.id ||
    value.sha256 !== expected.sha256 ||
    pass.receivedRows !== rows.length
  )
    throw new TypeError("Business delivery identity or payload digest differs");
}

/** Absence is an explicit compatibility state, never an inferred receipt. */
export function syncDeliveryEvidence(pass?: PassTallyInput | null) {
  return pass?.delivery
    ? ("identified-v1" as const)
    : ("legacy-ambiguous" as const);
}

/** Deployment attestation, deliberately absent from production configuration.
 * Setting it requires recorded schema/receiver qualification and quiescence of
 * old consumers. The flag itself is not evidence that quiescence happened. */
export function requireSyncDeliveryQualification(env: unknown): void {
  if (
    !env ||
    typeof env !== "object" ||
    (env as { SYNC_DELIVERY_V1_READY?: unknown }).SYNC_DELIVERY_V1_READY !==
      "true"
  )
    throw new Error("Stable delivery v1 is not qualified for activation");
}

/** The pass row serializes overlapping PostgreSQL writers. A receipt INSERT
 * conflict aborts the ENTIRE transaction, including data and accounting. Only
 * an exact committed receipt can turn that failed attempt into a successful
 * duplicate acknowledgement. No catch-and-continue runs inside a transaction.
 * Receipts are retained: deleting them without permanent tombstones would
 * make a later replay count again. */
export async function commitSyncDelivery(
  store: ProducerStore,
  lane: string,
  rows: readonly Row[],
  pass: PassTallyInput | null | undefined,
  statements: readonly ProducerStatement[],
): Promise<void> {
  if (!pass?.delivery) {
    await store.transaction(statements);
    return;
  }
  const d = pass.delivery;
  verifySyncDelivery(d, lane, pass, rows);
  const table = PASS_TABLES[lane];
  const first = syncDeliveryKey(lane, rows[0]!);
  const last = syncDeliveryKey(lane, rows.at(-1)!);
  const parentId = d.parent_id ?? d.id,
    parentSha = d.parent_sha256 ?? d.sha256;
  const prefix: ProducerStatement[] = [
    {
      // A legacy tally under this capture cannot be retroactively certified.
      // The no-op UPDATE acquires the PG row lock before the overlap query.
      text: `INSERT INTO sync_delivery_passes(lane,captured_at,expected_rows)
        VALUES(?,?,CASE WHEN EXISTS(SELECT 1 FROM sync_delivery_passes WHERE lane=? AND captured_at=?)
          OR NOT EXISTS(SELECT 1 FROM ${table} WHERE captured_at=?) THEN CAST(? AS INTEGER) ELSE NULL END)
        ON CONFLICT(lane,captured_at) DO UPDATE SET expected_rows=CASE
          WHEN sync_delivery_passes.expected_rows=excluded.expected_rows THEN excluded.expected_rows ELSE NULL END`,
      values: [
        lane,
        pass.capturedAt,
        lane,
        pass.capturedAt,
        pass.capturedAt,
        pass.expectedRows,
      ],
    },
    {
      text: `INSERT INTO sync_delivery_receipts(lane,captured_at,id,sha256,parent_id,parent_sha256,first_key,last_key,row_count)
        VALUES(?,?,?,CASE WHEN NOT EXISTS(SELECT 1 FROM sync_delivery_receipts
          WHERE lane=? AND captured_at=? AND ((first_key<=? AND last_key>=?)
            OR (parent_id=? AND parent_sha256<>?)))
          AND (SELECT COALESCE(SUM(row_count),0) FROM sync_delivery_receipts WHERE lane=? AND captured_at=?)+?<=?
          THEN ? ELSE NULL END,?,?,?,?,?)`,
      values: [
        lane,
        pass.capturedAt,
        d.id,
        lane,
        pass.capturedAt,
        last,
        first,
        parentId,
        parentSha,
        lane,
        pass.capturedAt,
        rows.length,
        pass.expectedRows,
        d.sha256,
        parentId,
        parentSha,
        first,
        last,
        rows.length,
      ],
    },
  ];
  const business = statements.filter(
    (statement) =>
      !new RegExp(`^\\s*INSERT INTO ${table}\\s*\\(`, "i").test(statement.text),
  );
  const tally: ProducerStatement = {
    text: `INSERT INTO ${table}(captured_at,expected_rows,received_rows,completed_at)
      SELECT p.captured_at,p.expected_rows,SUM(r.row_count),CASE WHEN SUM(r.row_count)=p.expected_rows THEN CAST(? AS BIGINT) ELSE NULL END
      FROM sync_delivery_passes p JOIN sync_delivery_receipts r USING(lane,captured_at)
      WHERE p.lane=? AND p.captured_at=? GROUP BY p.captured_at,p.expected_rows
      ON CONFLICT(captured_at) DO UPDATE SET expected_rows=excluded.expected_rows,
      received_rows=excluded.received_rows,completed_at=COALESCE(${table}.completed_at,excluded.completed_at)`,
    values: [pass.nowMs, lane, pass.capturedAt],
  };
  try {
    if (prefix.length + business.length + 1 > 900)
      throw new RangeError("Delivery exceeds atomic statement budget");
    await store.transaction([...prefix, ...business, tally]);
  } catch (error) {
    // A lost COMMIT response also lands here. Absence remains a failure.
    const receipt = await store.first<{
      sha256: string;
      parent_id: string;
      parent_sha256: string;
      first_key: string;
      last_key: string;
      row_count: number;
      expected_rows: number;
    }>(
      `SELECT r.sha256,r.parent_id,r.parent_sha256,r.first_key,r.last_key,r.row_count,p.expected_rows
      FROM sync_delivery_receipts r JOIN sync_delivery_passes p USING(lane,captured_at)
      WHERE r.lane=? AND r.captured_at=? AND r.id=?`,
      [lane, pass.capturedAt, d.id],
    );
    if (
      !receipt ||
      receipt.sha256 !== d.sha256 ||
      receipt.parent_id !== parentId ||
      receipt.parent_sha256 !== parentSha ||
      receipt.first_key !== first ||
      receipt.last_key !== last ||
      Number(receipt.row_count) !== rows.length ||
      Number(receipt.expected_rows) !== pass.expectedRows
    )
      throw error;
  }
}
