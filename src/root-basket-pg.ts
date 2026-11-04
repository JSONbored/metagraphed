import { RootBasketCaptureSchema } from "../schemas-src/root-basket-capture.ts";
import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { PgTransaction } from "./pg-pool.ts";
import type { RootBasketStore } from "./root-basket-store.ts";
import {
  rootBasketCaptureDigest,
  rootBasketCaptureFits,
} from "./root-basket-capture-write.ts";

const SOURCE =
  "network_genesis_hash = ? AND finalized_block_hash = ? AND decoder_version = ?";
const readiness = `SELECT count(*) = 28 AND bool_and(tgenabled IN ('O', 'A')) AS ready
  FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND (
    (tgrelid IN (to_regclass('app.root_basket_captures'), to_regclass('app.root_basket_capture_pages'),
      to_regclass('app.root_basket_fund_snapshots'), to_regclass('app.root_basket_holdings'),
      to_regclass('app.root_basket_targets'), to_regclass('app.root_basket_capture_completions'),
      to_regclass('app.root_basket_current')) AND tgname = 'root_basket_write_lock') OR
    (tgrelid = to_regclass('app.root_basket_captures') AND tgname IN (
      'root_basket_check_replay', 'root_basket_captures_immutable_update', 'root_basket_captures_immutable_delete')) OR
    (tgrelid = to_regclass('app.root_basket_capture_pages') AND tgname IN (
      'root_basket_capture_pages_immutable_insert', 'root_basket_capture_pages_immutable_update',
      'root_basket_capture_pages_immutable_delete', 'root_basket_receipt_immutable')) OR
    (tgrelid = to_regclass('app.root_basket_fund_snapshots') AND tgname IN (
      'root_basket_fund_snapshots_immutable_insert', 'root_basket_fund_snapshots_immutable_update', 'root_basket_fund_snapshots_immutable_delete')) OR
    (tgrelid = to_regclass('app.root_basket_holdings') AND tgname IN (
      'root_basket_holdings_immutable_insert', 'root_basket_holdings_immutable_update', 'root_basket_holdings_immutable_delete')) OR
    (tgrelid = to_regclass('app.root_basket_targets') AND tgname IN (
      'root_basket_targets_immutable_insert', 'root_basket_targets_immutable_update', 'root_basket_targets_immutable_delete')) OR
    (tgrelid = to_regclass('app.root_basket_capture_completions') AND tgname IN ('root_basket_check_completion', 'root_basket_completion_immutable_update', 'root_basket_completion_immutable_delete')) OR
    (tgrelid = to_regclass('app.root_basket_current') AND tgname IN ('root_basket_current_ordered_insert', 'root_basket_current_ordered_update'))
  )`;
type Column = readonly [name: string, type: "text" | "bigint"];

/** All identifiers and types here are fixed local declarations, never input. */
async function insertRows(
  tx: PgTransaction,
  captureId: string,
  table: string,
  columns: readonly Column[],
  rows: readonly Record<string, unknown>[],
) {
  for (let start = 0; start < rows.length; start += 1000)
    await tx.run(
      `INSERT INTO app.${table} (capture_id,${columns.map(([name]) => name).join(",")})
       SELECT ?,${columns.map(([name]) => `r.${name}`).join(",")}
       FROM jsonb_to_recordset(?::jsonb) AS r(${columns.map(([name, type]) => `${name} ${type}`).join(",")})`,
      [captureId, JSON.stringify(rows.slice(start, start + 1000))],
    );
}

/** Preserve source TEXT quantities and atomic completion over one process lease. */
export function createPgRootBasketStore(
  runtime: Pick<PgStoreRuntime, "transaction">,
): RootBasketStore {
  const withStore = <T>(operation: (tx: PgTransaction) => Promise<T>) =>
    runtime.transaction(
      async (tx) => {
        await tx.run("SET LOCAL search_path = pg_catalog, app, pg_temp");
        if (!(await tx.first<{ ready: boolean }>(readiness))?.ready)
          throw new Error("Root basket PostgreSQL family is not activated");
        return operation(tx);
      },
      { isolation: "read committed" },
    );
  return {
    read: {
      query: (text, values) => withStore((tx) => tx.query(text, values)),
      first: (text, values) => withStore((tx) => tx.first(text, values)),
    },
    async write(input, acceptedAtMs) {
      const capture = RootBasketCaptureSchema.parse(input);
      if (!rootBasketCaptureFits(capture))
        throw new Error("root basket capture exceeds row limits");
      const digest = rootBasketCaptureDigest(capture);
      const source = [
        capture.network_genesis_hash,
        capture.finalized_block_hash,
        capture.decoder_version,
      ];
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
      return withStore(async (tx) => {
        const inserted = await tx.run(
          `INSERT INTO app.root_basket_captures (${Object.keys(metadata).join(",")})
           VALUES (${Object.keys(metadata)
             .map(() => "?")
             .join(",")})
           ON CONFLICT(network_genesis_hash,finalized_block_hash,decoder_version) DO NOTHING`,
          Object.values(metadata),
        );
        const retained = await tx.first<{ capture_id: string }>(
          `SELECT capture_id FROM app.root_basket_captures WHERE ${SOURCE}`,
          source,
        );
        if (!retained)
          throw new Error("accepted root basket capture is absent");
        // The manifest trigger validated replay identity under the family lock.
        // Completed replays retain the first ID, times and all child receipts.
        const id = retained.capture_id;
        if (inserted.changes !== 0) {
          await insertRows(
            tx,
            id,
            "root_basket_capture_pages",
            [
              ["page_index", "bigint"],
              ["start_after", "text"],
              ["next_after", "text"],
              ["response_sha256", "text"],
              ["fund_count", "bigint"],
            ],
            capture.pages,
          );
          await insertRows(
            tx,
            id,
            "root_basket_fund_snapshots",
            [
              ["hotkey", "text"],
              ["page_index", "bigint"],
              ["shares_atomic", "text"],
              ["spot_nav_rao", "text"],
              ["realizable_nav_rao", "text"],
              ["deposited_rao", "text"],
              ["redeemed_rao", "text"],
              ["raw_spot_price_q64_bits", "text"],
              ["display_price_q64_bits", "text"],
              ["display_shares_q64_bits", "text"],
              ["stake_price_q64_bits", "text"],
              ["staker_twr_q64_bits", "text"],
              ["pending_entitlement_q64_bits", "text"],
              ["provisional", "bigint"],
              ["first_block", "text"],
              ["price_divisor_q64_bits", "text"],
              ["rate0_q32_bits", "text"],
              ["tr_splice_q64_bits", "text"],
              ["holdings_count", "bigint"],
              ["targets_count", "bigint"],
            ],
            capture.funds.map(({ baseline, holdings, targets, ...fund }) => ({
              ...fund,
              ...baseline,
              provisional: baseline.provisional ? 1 : 0,
              holdings_count: holdings.length,
              targets_count: targets.length,
            })),
          );
          await insertRows(
            tx,
            id,
            "root_basket_holdings",
            [
              ["hotkey", "text"],
              ["netuid", "bigint"],
              ["quantity_atomic", "text"],
              ["quantity_unit", "text"],
              ["spot_value_rao", "text"],
              ["realizable_value_rao", "text"],
            ],
            capture.funds.flatMap((fund) =>
              fund.holdings.map((row) => ({ hotkey: fund.hotkey, ...row })),
            ),
          );
          await insertRows(
            tx,
            id,
            "root_basket_targets",
            [
              ["hotkey", "text"],
              ["netuid", "bigint"],
              ["weight", "bigint"],
            ],
            capture.funds.flatMap((fund) =>
              fund.targets.map((row) => ({ hotkey: fund.hotkey, ...row })),
            ),
          );
          await tx.run(
            "INSERT INTO app.root_basket_capture_completions (capture_id,content_sha256,accepted_at_ms) VALUES (?,?,?)",
            [id, digest, String(acceptedAtMs)],
          );
        }
        await tx.run(
          `INSERT INTO app.root_basket_current (network_genesis_hash,decoder_version,capture_id) VALUES (?,?,?)
           ON CONFLICT(network_genesis_hash,decoder_version) DO UPDATE SET capture_id = excluded.capture_id
           WHERE (SELECT ROW(length(finalized_block),finalized_block) FROM app.root_basket_captures WHERE capture_id = root_basket_current.capture_id)
             < (SELECT ROW(length(finalized_block),finalized_block) FROM app.root_basket_captures WHERE capture_id = excluded.capture_id)`,
          [capture.network_genesis_hash, capture.decoder_version, id],
        );
        return {
          capture_id: id,
          content_sha256: digest,
          replayed: inserted.changes === 0,
        };
      });
    },
  };
}
