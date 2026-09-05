import { createHash } from "node:crypto";
import type { z } from "zod";
import { RootBasketCaptureSchema } from "../schemas-src/root-basket-capture.ts";
import type { ProducerStatement, ProducerStore } from "./producer-store.ts";

type Capture = z.infer<typeof RootBasketCaptureSchema>;

// Receiver work ceilings, independent of the transport byte cap. These are
// initial acceptance bounds, not a measurement of production capture sizes.
export const ROOT_BASKET_CAPTURE_LIMITS = {
  pages: 256,
  funds: 2_048,
  children: 32_768,
} as const;
const INSERT_BATCH_ROWS = 1_000;

export function rootBasketCaptureFits(capture: Capture): boolean {
  return (
    capture.pages.length <= ROOT_BASKET_CAPTURE_LIMITS.pages &&
    capture.funds.length <= ROOT_BASKET_CAPTURE_LIMITS.funds &&
    capture.funds.reduce(
      (n, fund) => n + fund.holdings.length + fund.targets.length,
      0,
    ) <= ROOT_BASKET_CAPTURE_LIMITS.children
  );
}

/** Object field order and unordered fund/child arrays do not define identity.
 * Attempt IDs/times are excluded; first accepted provenance remains immutable.
 * Source height/hash, metadata, index, cursor receipts and all values are included.
 */
export function rootBasketCaptureDigest(capture: Capture): string {
  const { capture_id, started_at_ms, finished_at_ms, ...observation } = capture;
  void capture_id;
  void started_at_ms;
  void finished_at_ms;
  const normalized = {
    ...observation,
    funds: [...capture.funds]
      .sort((a, b) => a.hotkey.localeCompare(b.hotkey))
      .map((fund) => ({
        ...fund,
        holdings: [...fund.holdings].sort((a, b) => a.netuid - b.netuid),
        targets: [...fund.targets].sort((a, b) => a.netuid - b.netuid),
      })),
  };
  // The schema has constructed every object in declared field order.
  return `0x${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

const SOURCE = `network_genesis_hash = $2 AND finalized_block_hash = $3 AND decoder_version = $4`;
const CAPTURE_ID = `(SELECT capture_id FROM root_basket_captures WHERE ${SOURCE})`;
const UNCOMPLETED = `NOT EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id = ${CAPTURE_ID})`;

/** Only fixed local table/column definitions reach this statement builder.
 * Each batch spends four bind parameters regardless of its row/column count.
 */
function insertBatches(
  capture: Capture,
  table: string,
  columns: readonly (readonly [string, string])[],
  rows: readonly Record<string, unknown>[],
): ProducerStatement[] {
  const statements: ProducerStatement[] = [];
  for (let start = 0; start < rows.length; start += INSERT_BATCH_ROWS) {
    statements.push({
      text: `INSERT INTO ${table} (capture_id, ${columns.map(([name]) => name).join(", ")})
        SELECT ${CAPTURE_ID}, ${columns.map(([name]) => `r.${name}`).join(", ")}
        FROM jsonb_to_recordset($1::jsonb) AS r(${columns.map(([name, type]) => `${name} ${type}`).join(", ")})
        WHERE ${UNCOMPLETED}`,
      values: [
        JSON.stringify(rows.slice(start, start + INSERT_BATCH_ROWS)),
        capture.network_genesis_hash,
        capture.finalized_block_hash,
        capture.decoder_version,
      ],
    });
  }
  return statements;
}

export async function writeRootBasketCapture(
  store: ProducerStore,
  input: unknown,
  acceptedAtMs: number,
): Promise<{ capture_id: string; content_sha256: string; replayed: boolean }> {
  const capture = RootBasketCaptureSchema.parse(input);
  if (!rootBasketCaptureFits(capture))
    throw new Error("root basket capture exceeds row limits");
  const digest = rootBasketCaptureDigest(capture);
  const metadata = {
    capture_id: capture.capture_id,
    network: capture.network,
    network_genesis_hash: capture.network_genesis_hash,
    finalized_block_hash: capture.finalized_block_hash,
    finalized_block: capture.finalized_block,
    runtime_spec_version: capture.runtime_spec_version,
    runtime_api_version: capture.runtime_api_version,
    decoder_version: capture.decoder_version,
    metadata_sha256: capture.metadata_sha256,
    started_at_ms: capture.started_at_ms,
    finished_at_ms: capture.finished_at_ms,
    expected_pages: capture.expected_pages,
    expected_funds: capture.expected_funds,
    index_status: capture.index.status,
    index_completed_block: capture.index.completed_block,
    bag_index_q64_bits: capture.index.bag_q64_bits,
    stake_index_q64_bits: capture.index.stake_q64_bits,
  };
  const statements: ProducerStatement[] = [
    {
      text: "SELECT root_basket_check_replay($1::jsonb, $2)",
      values: [JSON.stringify(metadata), digest],
    },
    {
      text: `INSERT INTO root_basket_captures (${Object.keys(metadata).join(", ")})
        SELECT $1::uuid, $2::text, $3::text, $4::text, $5::numeric,
          $6::numeric, $7::numeric, $8::text, $9::text, $10::numeric,
          $11::numeric, $12::numeric, $13::numeric, $14::text, $15::numeric,
          $16::numeric, $17::numeric
        WHERE NOT EXISTS (SELECT 1 FROM root_basket_captures
          WHERE network_genesis_hash = $3 AND finalized_block_hash = $4 AND decoder_version = $8)`,
      values: Object.values(metadata),
    },
    ...insertBatches(
      capture,
      "root_basket_capture_pages",
      [
        ["page_index", "numeric"],
        ["start_after", "text"],
        ["next_after", "text"],
        ["response_sha256", "text"],
        ["fund_count", "numeric"],
      ],
      capture.pages,
    ),
    ...insertBatches(
      capture,
      "root_basket_fund_snapshots",
      [
        ["hotkey", "text"],
        ["page_index", "numeric"],
        ["shares_atomic", "numeric"],
        ["spot_nav_rao", "numeric"],
        ["realizable_nav_rao", "numeric"],
        ["deposited_rao", "numeric"],
        ["redeemed_rao", "numeric"],
        ["raw_spot_price_q64_bits", "numeric"],
        ["display_price_q64_bits", "numeric"],
        ["display_shares_q64_bits", "numeric"],
        ["stake_price_q64_bits", "numeric"],
        ["staker_twr_q64_bits", "numeric"],
        ["pending_entitlement_q64_bits", "numeric"],
        ["provisional", "boolean"],
        ["first_block", "numeric"],
        ["price_divisor_q64_bits", "numeric"],
        ["rate0_q32_bits", "numeric"],
        ["tr_splice_q64_bits", "numeric"],
        ["holdings_count", "numeric"],
        ["targets_count", "numeric"],
      ],
      capture.funds.map(({ baseline, holdings, targets, ...fund }) => ({
        ...fund,
        ...baseline,
        holdings_count: holdings.length,
        targets_count: targets.length,
      })),
    ),
    ...insertBatches(
      capture,
      "root_basket_holdings",
      [
        ["hotkey", "text"],
        ["netuid", "numeric"],
        ["quantity_atomic", "numeric"],
        ["quantity_unit", "text"],
        ["spot_value_rao", "numeric"],
        ["realizable_value_rao", "numeric"],
      ],
      capture.funds.flatMap((fund) =>
        fund.holdings.map((row) => ({ hotkey: fund.hotkey, ...row })),
      ),
    ),
    ...insertBatches(
      capture,
      "root_basket_targets",
      [
        ["hotkey", "text"],
        ["netuid", "numeric"],
        ["weight", "numeric"],
      ],
      capture.funds.flatMap((fund) =>
        fund.targets.map((row) => ({ hotkey: fund.hotkey, ...row })),
      ),
    ),
    {
      text: `SELECT root_basket_complete_capture(
        (SELECT capture_id FROM root_basket_captures WHERE network_genesis_hash = $1
          AND finalized_block_hash = $2 AND decoder_version = $3), $4, $5)`,
      values: [
        capture.network_genesis_hash,
        capture.finalized_block_hash,
        capture.decoder_version,
        digest,
        String(acceptedAtMs),
      ],
    },
  ];
  const result = await store.transaction(statements);
  // Completeness was checked inside the transaction by a function that throws.
  // This read only resolves the retained ID after an identical replay.
  const receipt = await store.first<{ capture_id: string }>(
    `SELECT capture_id FROM root_basket_captures WHERE network_genesis_hash = $1
      AND finalized_block_hash = $2 AND decoder_version = $3`,
    [
      capture.network_genesis_hash,
      capture.finalized_block_hash,
      capture.decoder_version,
    ],
  );
  if (!receipt) throw new Error("accepted root basket capture is absent");
  return {
    capture_id: receipt.capture_id,
    content_sha256: digest,
    replayed: result[1]!.changes === 0,
  };
}
