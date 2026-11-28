import type { ChainNetworkId } from "./chain-network.ts";
import { recordOrNull } from "./read-store.ts";

/** A read-only query handle over the chain core's views (migration 0058). */
export interface ChainViewsStore {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<Row[]>;
}

/**
 * The chain core's read-only views (the `chain_views` native source), where
 * the native application binds them, or null. A reader that gets null keeps
 * the source it had before the chain core existed.
 */
function isChainViewsStore(value: unknown): value is ChainViewsStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "query" in value &&
    typeof value.query === "function"
  );
}

export function chainViewsStore(env: unknown): ChainViewsStore | null {
  const store = recordOrNull(recordOrNull(env)?.NATIVE_CHAIN_READ_STORE)?.store;
  return isChainViewsStore(store) ? store : null;
}

/** The chain core keys a network by its chain's own name. */
export function chainCoreNetwork(network: ChainNetworkId): string {
  return network === "mainnet" ? "finney" : network;
}

/** The block store leg's row (blocks-cold-tier.ts), from the chain core's
 * view (ADR 0029 phase 1b). The core holds no parent hash or author yet, so
 * both read as unknown; every block it holds is fully decoded, so its status
 * is its economics' completeness. */
const BLOCK_SELECT =
  "block_number, block_hash, NULL AS parent_hash, extrinsic_count, " +
  "observed_at, NULL AS author, spec_version, chain_event_count AS event_count, " +
  "CASE WHEN economics_complete THEN 'complete' ELSE 'unavailable' END AS decode_status, " +
  "native_transfer_tao, stake_flow_tao, economic_activity_tao, fee_tao, tip_tao, " +
  "issuance_tao, subnet_ids";

/** A page of blocks newest first, under the caller's bound predicates. */
export function chainCoreBlockFeedSql(
  where: readonly string[],
  observedOrder: boolean,
): string {
  return (
    `SELECT ${BLOCK_SELECT} FROM chain.block_rows WHERE ${where.join(" AND ")} ` +
    `ORDER BY ${observedOrder ? "observed_at DESC, block_number DESC" : "block_number DESC"} LIMIT ?`
  );
}

/** One block by height: (network, height). */
export const CHAIN_CORE_BLOCK_BY_HEIGHT = `SELECT ${BLOCK_SELECT} FROM chain.block_rows WHERE network_id = ? AND block_number = ? LIMIT 1`;

/** One block by hash: (network, network, hex without 0x). The hash resolves
 * through the base table's own index; the view renders it as text, which no
 * index of it can answer. */
export const CHAIN_CORE_BLOCK_BY_HASH =
  `SELECT ${BLOCK_SELECT} FROM chain.block_rows WHERE network_id = ? AND block_number = ` +
  `(SELECT block_number FROM chain.blocks WHERE network_id = ? AND block_hash = decode(?, 'hex')) LIMIT 1`;

/** The detail families whose complete ranges bound the block-detail hot tier. */
const DETAIL_FAMILIES = "('extrinsics', 'events', 'account_events')";

/** A block is covered for detail only inside every detail family's complete
 * range: its header is kept for all of history, its detail is not. Correlated
 * on the outer `b` (a chain.blocks row). */
const COVERED =
  "(SELECT COUNT(*) FROM chain.coverage c WHERE c.network_id = b.network_id " +
  `AND c.family IN ${DETAIL_FAMILIES} ` +
  "AND b.block_number BETWEEN c.complete_from AND c.complete_through) = 3";

/** A column list qualified by a table alias, for reads that join. */
function qualified(columns: string, alias: string): string {
  return columns
    .split(", ")
    .map((column) => `${alias}.${column}`)
    .join(", ");
}

/**
 * The block-detail hot tier's statements over the chain core (ADR 0029 phase
 * 1b), one per D1-era statement in src/chain-detail-hot-tier.ts, which binds
 * them. Every one takes the network first. `columns` is the caller's own
 * column list, so both stores hand the formatters the identical shape.
 *
 * Feeds order by (block, index) -- the partition key and the order every index
 * holds -- and their rows' `observed_at` is the block's own time (0059), so
 * that order is the feed's time order too.
 */
export const CHAIN_CORE_DETAIL = Object.freeze({
  /** (network, network): the window every detail family holds, and its head's time. */
  coverage:
    "SELECT w.floor, w.head, (SELECT chain.epoch_ms(COALESCE(b.produced_at, b.observed_at)) " +
    "FROM chain.blocks b WHERE b.network_id = ? AND b.block_number = w.head) AS observed " +
    "FROM (SELECT MAX(complete_from) AS floor, MIN(complete_through) AS head, COUNT(*) AS families " +
    `FROM chain.coverage WHERE network_id = ? AND family IN ${DETAIL_FAMILIES}) w ` +
    "WHERE w.families = 3 AND w.floor <= w.head",
  /** (network, height): a row only when the block is covered. */
  coveredHeight: `SELECT b.block_number FROM chain.blocks b WHERE b.network_id = ? AND b.block_number = ? AND ${COVERED} LIMIT 1`,
  /** (network, hash hex without 0x): the height a hash names, through the base
   * table's own index, and whether it is covered. */
  coveredHash: `SELECT b.block_number, ${COVERED} AS covered FROM chain.blocks b WHERE b.network_id = ? AND b.block_hash = decode(?, 'hex') LIMIT 1`,
  /** (network): the time of the first block the account index holds completely. */
  accountEventsFloor:
    "SELECT chain.epoch_ms(COALESCE(b.produced_at, b.observed_at)) AS floor_ms FROM chain.coverage c " +
    "JOIN chain.blocks b ON b.network_id = c.network_id AND b.block_number = c.complete_from " +
    "WHERE c.network_id = ? AND c.family = 'account_events'",
  /** (ss58, network, limit, network, limit, network, limit): an account's
   * newest account events. The address resolves to its account once; each
   * side of the disjunction reads its own ordered index (coldkey or hotkey,
   * block descending) and stops at the page, so a busy validator's thousands
   * of rows are never sorted to find the newest few. */
  accountEvents: (columns: string) =>
    "WITH me AS (SELECT account FROM chain.accounts WHERE ss58 = ?), hits AS (" +
    "(SELECT e.block_number, e.event_index FROM chain.account_events e JOIN me ON e.coldkey = me.account " +
    "WHERE e.network_id = ? ORDER BY e.block_number DESC, e.event_index DESC LIMIT ?) UNION " +
    "(SELECT e.block_number, e.event_index FROM chain.account_events e JOIN me ON e.hotkey = me.account " +
    "WHERE e.network_id = ? ORDER BY e.block_number DESC, e.event_index DESC LIMIT ?)) " +
    `SELECT ${qualified(columns, "r")} FROM chain.account_event_rows r ` +
    "JOIN hits h ON h.block_number = r.block_number AND h.event_index = r.event_index " +
    "WHERE r.network_id = ? ORDER BY r.block_number DESC, r.event_index DESC LIMIT ?",
  /** (network, ss58, ss58, limit): an account's events of the listed kinds,
   * which the caller passes as quoted literals from a fixed in-repo list. */
  accountKindEvents: (columns: string, kinds: string) =>
    `SELECT ${columns} FROM chain.account_event_rows ` +
    "WHERE network_id = ? AND (coldkey_account = (SELECT account FROM chain.accounts WHERE ss58 = ?) " +
    "OR hotkey_account = (SELECT account FROM chain.accounts WHERE ss58 = ?)) " +
    `AND event_kind IN (${kinds}) ORDER BY block_number DESC, event_index DESC LIMIT ?`,
  /** (network, height, limit, offset). */
  blockExtrinsics: (columns: string) =>
    `SELECT ${columns} FROM chain.extrinsic_rows ` +
    "WHERE network_id = ? AND block_number = ? ORDER BY extrinsic_index ASC LIMIT ? OFFSET ?",
  /** (network, height, limit, offset). */
  blockAccountEvents: (columns: string) =>
    `SELECT ${columns} FROM chain.account_event_rows ` +
    "WHERE network_id = ? AND block_number = ? ORDER BY event_index ASC LIMIT ? OFFSET ?",
  /** (network, height): the rows the account index holds for the block -- the
   * set the page reads, since pallet accounts' fee and emission bookkeeping is
   * not indexed (those events stay in the chain events). */
  blockAccountEventCount:
    "SELECT COUNT(*)::integer AS account_event_count FROM chain.account_events " +
    "WHERE network_id = ? AND block_number = ?",
  /** (network, ...the where's own values, limit). */
  extrinsicFeed: (columns: string, where: readonly string[]) =>
    `SELECT ${columns} FROM chain.extrinsic_rows WHERE ` +
    ["network_id = ?", ...where].join(" AND ") +
    " ORDER BY block_number DESC, extrinsic_index DESC LIMIT ?",
  /** (network, ...the where's own values, limit). */
  chainEventFeed: (columns: string, where: readonly string[]) =>
    `SELECT ${columns} FROM chain.chain_event_rows WHERE ` +
    ["network_id = ?", ...where].join(" AND ") +
    " ORDER BY block_number DESC, event_index DESC LIMIT ?",
  /** (network, height). */
  blockChainEvents: (columns: string) =>
    `SELECT ${columns} FROM chain.chain_event_rows ` +
    "WHERE network_id = ? AND block_number = ? ORDER BY event_index ASC",
  /** (network, height, index). */
  extrinsicAt: (columns: string) =>
    `SELECT ${columns} FROM chain.extrinsic_rows ` +
    "WHERE network_id = ? AND block_number = ? AND extrinsic_index = ? LIMIT 1",
  /** (network, network, hash hex without 0x): through the base table's own
   * index (the view renders the hash as text, which no index of it can
   * answer); the newest holder wins should two extrinsics ever share one. */
  extrinsicByHash: (columns: string) =>
    `SELECT ${columns} FROM chain.extrinsic_rows WHERE network_id = ? AND ` +
    "(block_number, extrinsic_index) = (SELECT block_number, extrinsic_index FROM chain.extrinsics " +
    "WHERE network_id = ? AND extrinsic_hash = decode(?, 'hex') ORDER BY block_number DESC LIMIT 1) LIMIT 1",
  /** (network, height, index, limit): the account events one extrinsic emitted. */
  extrinsicAccountEvents: (columns: string) =>
    `SELECT ${columns} FROM chain.account_event_rows ` +
    "WHERE network_id = ? AND block_number = ? AND extrinsic_index = ? " +
    "ORDER BY event_index ASC LIMIT ?",
});
