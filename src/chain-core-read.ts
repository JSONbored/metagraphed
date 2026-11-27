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
