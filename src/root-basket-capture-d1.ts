// Native SQLite capture transaction; D1 serializes the whole batch. Completion
// and replay checks live in database triggers so no concurrent writer can
// publish an incomplete observation between an application read and write.
import { RootBasketCaptureSchema } from "../schemas-src/root-basket-capture.ts";
import type { ProducerStatement, ProducerStore } from "./producer-store.ts";
import {
  rootBasketCaptureDigest,
  rootBasketCaptureFits,
} from "./root-basket-capture-write.ts";

export const ROOT_BASKET_D1_TABLES = [
  "root_basket_captures",
  "root_basket_capture_pages",
  "root_basket_fund_snapshots",
  "root_basket_holdings",
  "root_basket_targets",
  "root_basket_capture_completions",
  "root_basket_current",
] as const;
const SOURCE =
  "network_genesis_hash = ? AND finalized_block_hash = ? AND decoder_version = ?";
const CAPTURE_ID = `(SELECT capture_id FROM root_basket_captures WHERE ${SOURCE})`;
type Capture = ReturnType<typeof RootBasketCaptureSchema.parse>;
function source(capture: Capture): unknown[] {
  return [
    capture.network_genesis_hash,
    capture.finalized_block_hash,
    capture.decoder_version,
  ];
}
function insertBatches(
  capture: Capture,
  table: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): ProducerStatement[] {
  const statements: ProducerStatement[] = [];
  for (let start = 0; start < rows.length; start += 1000) {
    statements.push({
      text: `INSERT INTO ${table} (capture_id, ${columns.join(",")})
        SELECT ${CAPTURE_ID}, ${columns.map((name) => `json_extract(r.value, '$.${name}')`).join(",")}
        FROM json_each(?) r WHERE NOT EXISTS (
          SELECT 1 FROM root_basket_capture_completions WHERE capture_id = ${CAPTURE_ID})`,
      values: [
        ...source(capture),
        JSON.stringify(rows.slice(start, start + 1000)),
        ...source(capture),
      ],
    });
  }
  return statements;
}
export async function writeRootBasketCaptureD1(
  store: ProducerStore,
  input: unknown,
  acceptedAtMs: number,
) {
  const capture = RootBasketCaptureSchema.parse(input);
  if (!rootBasketCaptureFits(capture))
    throw new Error("root basket capture exceeds row limits");
  const digest = rootBasketCaptureDigest(capture);
  const metadata = {
    capture_id: capture.capture_id,
    content_sha256: digest,
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
      text: `INSERT INTO root_basket_captures (${Object.keys(metadata).join(",")})
      VALUES (${Object.keys(metadata)
        .map(() => "?")
        .join(",")})
      ON CONFLICT(network_genesis_hash,finalized_block_hash,decoder_version) DO NOTHING`,
      values: Object.values(metadata),
    },
    ...insertBatches(
      capture,
      "root_basket_capture_pages",
      [
        "page_index",
        "start_after",
        "next_after",
        "response_sha256",
        "fund_count",
      ],
      capture.pages,
    ),
    ...insertBatches(
      capture,
      "root_basket_fund_snapshots",
      [
        "hotkey",
        "page_index",
        "shares_atomic",
        "spot_nav_rao",
        "realizable_nav_rao",
        "deposited_rao",
        "redeemed_rao",
        "raw_spot_price_q64_bits",
        "display_price_q64_bits",
        "display_shares_q64_bits",
        "stake_price_q64_bits",
        "staker_twr_q64_bits",
        "pending_entitlement_q64_bits",
        "provisional",
        "first_block",
        "price_divisor_q64_bits",
        "rate0_q32_bits",
        "tr_splice_q64_bits",
        "holdings_count",
        "targets_count",
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
        "hotkey",
        "netuid",
        "quantity_atomic",
        "quantity_unit",
        "spot_value_rao",
        "realizable_value_rao",
      ],
      capture.funds.flatMap((fund) =>
        fund.holdings.map((row) => ({ hotkey: fund.hotkey, ...row })),
      ),
    ),
    ...insertBatches(
      capture,
      "root_basket_targets",
      ["hotkey", "netuid", "weight"],
      capture.funds.flatMap((fund) =>
        fund.targets.map((row) => ({ hotkey: fund.hotkey, ...row })),
      ),
    ),
    {
      text: `INSERT INTO root_basket_capture_completions (capture_id,content_sha256,accepted_at_ms)
      SELECT capture_id,content_sha256,? FROM root_basket_captures WHERE ${SOURCE}
      AND NOT EXISTS (SELECT 1 FROM root_basket_capture_completions c
        WHERE c.capture_id = root_basket_captures.capture_id)`,
      values: [String(acceptedAtMs), ...source(capture)],
    },
    {
      text: `INSERT INTO root_basket_current (network_genesis_hash,decoder_version,capture_id)
      SELECT network_genesis_hash,decoder_version,capture_id FROM root_basket_captures WHERE ${SOURCE}
      ON CONFLICT(network_genesis_hash,decoder_version) DO UPDATE SET capture_id = excluded.capture_id
      WHERE (SELECT length(finalized_block),finalized_block FROM root_basket_captures WHERE capture_id = root_basket_current.capture_id)
        < (SELECT length(finalized_block),finalized_block FROM root_basket_captures WHERE capture_id = excluded.capture_id)`,
      values: source(capture),
    },
  ];
  const result = await store.transaction(statements);
  const receipt = await store.first<{ capture_id: string }>(
    `SELECT capture_id FROM root_basket_captures WHERE ${SOURCE}`,
    source(capture),
  );
  if (!receipt) throw new Error("accepted root basket capture is absent");
  return {
    capture_id: receipt.capture_id,
    content_sha256: digest,
    replayed: result[0]!.changes === 0,
  };
}
