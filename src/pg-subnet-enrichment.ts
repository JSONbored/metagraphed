import type { PgStoreRuntime } from "./pg-store-runtime.ts";
import type { createSqliteDocumentDecoder } from "./sqlite-document-decoder.ts";
import type { SubnetEnrichmentStore } from "./subnet-enrichment-store.ts";
import type {
  ComputeDeclarations,
  NominatorPositions,
  TreasuryReadings,
} from "../generated/db/types.ts";
import { createPgNeuronDailyViewStore } from "./pg-neuron-daily-view.ts";

function network(value: number): string | null {
  if (!Number.isInteger(value) || !Number.isFinite(value))
    throw new TypeError("Invalid native subnet identity");
  const integer = BigInt(value);
  return integer < -(1n << 63n) || integer >= 1n << 63n
    ? null
    : integer.toString();
}
function complete<Row>(rows: Row[], limit = 100000): Row[] {
  if (rows.length > limit)
    throw new RangeError(
      "Native subnet enrichment exceeds its complete-row budget",
    );
  return rows;
}
/** Preserve the source join's single database snapshot while the canonical
 * document projection is decoded outside PostgreSQL. */
export function createPgSubnetEnrichmentStore(
  runtime: Pick<PgStoreRuntime, "read" | "transaction">,
  decoder: ReturnType<typeof createSqliteDocumentDecoder>,
): SubnetEnrichmentStore {
  return {
    async dailyRows(netuid, cutoff, kind, limit) {
      if (kind !== "emission" && kind !== "owner")
        throw new TypeError("Invalid native subnet history kind");
      return runtime.transaction(
        async (scope) => {
          const daily = createPgNeuronDailyViewStore({ read: scope }, decoder);
          const rows = await daily.rows({
            netuid,
            fromDay: cutoff,
            columns: [
              "snapshot_date",
              "uid",
              "hotkey",
              "validator_permit",
              "emission_tao",
              ...(kind === "owner" ? ["coldkey", "take"] : []),
            ],
            sameDayOrder: kind === "emission" ? "shard" : "uid",
            limit,
          });
          if (!rows.length) return rows;
          const dates = [
            ...new Set(rows.map((row) => String(row.snapshot_date))),
          ];
          const snapshots = await scope.query<{
            snapshot_date: string;
            alpha_out_emission: number | null;
            alpha_price_tao: number | null;
          }>(
            `SELECT snapshot_date,alpha_out_emission,alpha_price_tao FROM app.subnet_snapshots
          WHERE netuid=$1::bigint AND snapshot_date=ANY($2::text[])`,
            [network(netuid), dates],
          );
          const byDate = new Map(
            snapshots.map((row) => [row.snapshot_date, row]),
          );
          return rows.map((row) => {
            const snapshot = byDate.get(String(row.snapshot_date));
            return {
              ...row,
              alpha_out_emission: snapshot?.alpha_out_emission ?? null,
              ...(kind === "emission"
                ? { alpha_price_tao: snapshot?.alpha_price_tao ?? null }
                : {}),
            };
          });
        },
        { isolation: "repeatable read" },
      );
    },
    async ownerColdkey(netuid) {
      const key = network(netuid);
      if (key === null) return null;
      const row = await runtime.read.first<{ owner_coldkey: string | null }>(
        "SELECT owner_coldkey FROM app.subnet_ownership WHERE netuid=$1::bigint ORDER BY captured_at DESC LIMIT 1",
        [key],
      );
      return row?.owner_coldkey ?? null;
    },
    async ownerPositions(netuid) {
      const key = network(netuid);
      if (key === null) return [];
      // The WITHOUT ROWID source appends coldkey to its capture-index order.
      // Tied attribution rows and floating accumulation retain that order.
      return complete(
        await runtime.read.query<
          Pick<NominatorPositions, "coldkey" | "hotkey" | "share_fraction">
        >(
          `SELECT coldkey,hotkey,share_fraction FROM app.nominator_positions WHERE netuid=$1::bigint
        AND captured_at=(SELECT MAX(captured_at) FROM app.nominator_positions WHERE netuid=$1::bigint)
        ORDER BY hotkey COLLATE "C",netuid,coldkey COLLATE "C" LIMIT 100001`,
          [key],
        ),
      );
    },
    async declarations(netuid) {
      const key = network(netuid);
      if (key === null) return [];
      return complete(
        await runtime.read.query<ComputeDeclarations>(
          `SELECT netuid,source_url,read_at_sha,observed_at,first_seen,found,spec_version,miner,validator,unscoped
        FROM app.compute_declarations WHERE netuid=$1::bigint ORDER BY source_url COLLATE "C" LIMIT 100001`,
          [key],
        ),
      );
    },
    async treasury(netuid) {
      const key = network(netuid);
      if (key === null) return [];
      return complete(
        await runtime.read.query<TreasuryReadings>(
          `SELECT netuid,source_url,read_at_sha,observed_at,first_seen,found,declared_share,treasury_address,applies_to,evidence_path,review_state,reviewed_at
        FROM app.treasury_readings WHERE netuid=$1::bigint ORDER BY source_url COLLATE "C" LIMIT 100001`,
          [key],
        ),
      );
    },
    async usdDays(cutoffMs, lastDayMs) {
      if (
        !Number.isSafeInteger(cutoffMs) ||
        !Number.isSafeInteger(lastDayMs) ||
        Math.max(0, lastDayMs - cutoffMs) > 366 * 86400000
      )
        throw new TypeError("Invalid bounded native USD day window");
      return runtime.read.query<{
        observed_at: number | string | null;
        usd_per_tao: number | null;
      }>(
        `WITH RECURSIVE days(start) AS (SELECT $1::bigint UNION ALL SELECT start+86400000 FROM days WHERE start+86400000<=$2::bigint)
        SELECT (SELECT observed_at FROM app.tao_usd_index WHERE observed_at>=days.start AND observed_at<days.start+86400000 AND usd_per_tao IS NOT NULL ORDER BY observed_at DESC,block_number DESC LIMIT 1) AS observed_at,
        (SELECT usd_per_tao FROM app.tao_usd_index WHERE observed_at>=days.start AND observed_at<days.start+86400000 AND usd_per_tao IS NOT NULL ORDER BY observed_at DESC,block_number DESC LIMIT 1) AS usd_per_tao FROM days`,
        [cutoffMs, lastDayMs],
      );
    },
  };
}
