// The commitment serving builders (MET-7365) -- shared by the REST handlers,
// the GraphQL resolvers and the MCP tools, so the surfaces cannot drift. Pure
// + exported for tests; the loaders resolve the store (the native seam in
// commitments-store.ts) and hand the rows in.
//
// A COMMITMENT IS THE CHAIN'S, READ WHOLE. Each Data field is served with its
// kind and bytes, and as text where the bytes are printable UTF-8; a row
// whose stored value does not read as one is never served as one.
//
// THE DECLINE IS NULL. With no store bound or no capture observed,
// `observed_block` is null and there are no rows: an empty list would claim
// the subnet's miners published nothing.
import { hexBytes } from "./chain-storage-read.ts";
import {
  type CommitmentRow,
  type CommitmentsObservation,
  type HotkeyCommitmentHistory,
  selectedCommitmentsStore,
  type SubnetCommitmentsPage,
} from "./commitments-store.ts";
import { decodeSs58, encodeAccountId32 } from "./ss58.ts";

type Row = Record<string, unknown>;

const KINDS = new Set([
  "none",
  "raw",
  "big_raw",
  "blake2_256",
  "sha256",
  "keccak256",
  "sha3_256",
  "timelock",
  "timelock_failed",
  "reset_bonds",
]);
const HEX = /^0x(?:[0-9a-f]{2})*$/;
const U64 = /^(0|[1-9][0-9]{0,19})$/;

function blockOrNull(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function field(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { kind, hex, text, reveal_round } = value as Row;
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;
  if (hex !== undefined && (typeof hex !== "string" || !HEX.test(hex)))
    return null;
  if (text !== undefined && typeof text !== "string") return null;
  const round = reveal_round === undefined ? null : blockOrNull(reveal_round);
  if (reveal_round !== undefined && round === null) return null;
  return {
    kind,
    hex: hex ?? null,
    text: text ?? null,
    reveal_round: round,
  };
}

function reveal(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { block, hex, text } = value as Row;
  const at = blockOrNull(block);
  if (at === null || typeof hex !== "string" || !HEX.test(hex)) return null;
  if (text !== undefined && typeof text !== "string") return null;
  return { block: at, hex, text: text ?? null };
}

/** Every element read whole, or null: a list with one unreadable element is
 * not the chain's list. */
function all(
  value: unknown,
  read: (item: unknown) => Row | null,
): Row[] | null {
  if (!Array.isArray(value)) return null;
  const out: Row[] = [];
  for (const item of value) {
    const row = read(item);
    if (row === null) return null;
    out.push(row);
  }
  return out;
}

/** The hotkey a stored row names, as SS58. */
function hotkeyOf(hex: unknown): string | null {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex)) return null;
  return encodeAccountId32(hexBytes(`0x${hex}`));
}

/** One stored row as served, or null when it does not read whole. */
function formatRow(row: CommitmentRow): Row | null {
  const hotkey = hotkeyOf(row.hotkey);
  const validFrom = blockOrNull(row.valid_from);
  const reveals = all(row.reveals, reveal);
  if (hotkey === null || validFrom === null || reveals === null) return null;
  let commitment: Row | null = null;
  if (row.fields !== null) {
    const fields = all(row.fields, field);
    const block = blockOrNull(row.committed_block);
    if (
      fields === null ||
      block === null ||
      typeof row.deposit !== "string" ||
      !U64.test(row.deposit)
    )
      return null;
    commitment = { block, deposit: row.deposit, fields };
  }
  return {
    hotkey,
    valid_from: validFrom,
    valid_to: blockOrNull(row.valid_to),
    commitment,
    reveals,
  };
}

function observationFields(observation: CommitmentsObservation | null): Row {
  const block = blockOrNull(observation?.block_number);
  const ms = blockOrNull(observation?.observed_at_ms);
  return {
    observed_block: block,
    observed_at:
      block === null || ms === null ? null : new Date(ms).toISOString(),
  };
}

const formatted = (rows: readonly CommitmentRow[]) =>
  rows.map(formatRow).filter((row): row is Row => row !== null);

export function buildSubnetCommitments(
  page: SubnetCommitmentsPage | null,
  netuid: unknown,
  { limit, offset }: { limit: number; offset: number },
): Row {
  const observed = observationFields(page?.observation ?? null);
  // Rows are served only with the observation that dates them.
  const held = page && observed.observed_block !== null ? page : null;
  return {
    schema_version: 1,
    netuid,
    ...observed,
    total: held ? held.total : null,
    limit,
    offset,
    // A current row's range is open by definition: valid_to is not served.
    commitments: formatted(held?.rows ?? []).map((row) => ({
      hotkey: row.hotkey,
      valid_from: row.valid_from,
      commitment: row.commitment,
      reveals: row.reveals,
    })),
  };
}

export function buildHotkeyCommitment(
  history: HotkeyCommitmentHistory | null,
  netuid: unknown,
  hotkey: string,
): Row {
  const observed = observationFields(history?.observation ?? null);
  const held = history && observed.observed_block !== null ? history.rows : [];
  // The hotkey is the response's own: each row is its range and values.
  const rows = formatted(held).map((row) => ({
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    commitment: row.commitment,
    reveals: row.reveals,
  }));
  const current = rows.find((row) => row.valid_to === null) ?? null;
  return {
    schema_version: 1,
    netuid,
    hotkey,
    ...observed,
    // Whether the chain held anything for this hotkey at the observed block.
    exists: observed.observed_block === null ? null : current !== null,
    current,
    history: rows,
  };
}

/** The 32-byte public key an SS58 hotkey names, as hex without 0x, or null
 * when the address does not decode. */
export function hotkeyPublicKey(ss58: string): string | null {
  const decoded = decodeSs58(ss58);
  if (!decoded) return null;
  return [...decoded.publicKey]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * One page of a subnet's current commitments through the native seam, or
 * null.
 *
 * Null for "no store bound" AND for a store read that failed -- both render
 * as the same schema-stable decline, because a caller cannot act differently
 * on the two and an error body would turn a degraded tier into a hard failure
 * the sibling subnet routes never have.
 */
export async function loadSubnetCommitments(
  env: unknown,
  netuid: number,
  page: { limit: number; offset: number },
): Promise<SubnetCommitmentsPage | null> {
  const store = selectedCommitmentsStore(env);
  if (!store) return null;
  try {
    return await store.subnet(netuid, page);
  } catch (error) {
    console.error("commitments store read failed:", error);
    return null;
  }
}

/** One hotkey's commitment and its history on one subnet, or null (see
 * above). `hotkey` is the public key's hex. */
export async function loadHotkeyCommitment(
  env: unknown,
  netuid: number,
  hotkey: string,
): Promise<HotkeyCommitmentHistory | null> {
  const store = selectedCommitmentsStore(env);
  if (!store) return null;
  try {
    return await store.hotkey(netuid, hotkey);
  } catch (error) {
    console.error("commitments store read failed:", error);
    return null;
  }
}

/** One hotkey's commitment and its history, by its SS58 address, or null --
 * for an address that does not decode as for a store that cannot answer. */
export async function loadHotkeyCommitmentBySs58(
  env: unknown,
  netuid: number,
  ss58: string,
): Promise<HotkeyCommitmentHistory | null> {
  const publicKey = hotkeyPublicKey(ss58);
  return publicKey === null
    ? null
    : loadHotkeyCommitment(env, netuid, publicKey);
}
