import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  AlphaQuantityCaptureSchema,
  type AlphaQuantityCapture,
} from "../../src/alpha-quantity.ts";

const readFrozen = (spec: 454 | 478) =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/alpha-runtime/frozen-${spec}.json`, import.meta.url),
      "utf8",
    ),
  ).alpha_snapshot;
const runtimes = { 454: readFrozen(454), 478: readFrozen(478) };
const frozen = (spec: 454 | 478) => runtimes[spec];

/** Synthetic read-side captures use authentic pinned metadata. Their block,
 * timestamps, quantities and receipts are invented test state, not chain data.
 * Native ingestion/promotion is exercised separately in quantity-contract.test.ts. */
export function syntheticAlphaCapture(
  capturedAt: number,
  overrides: Partial<AlphaQuantityCapture> = {},
): AlphaQuantityCapture {
  const runtime = frozen(overrides.spec_version ?? 454);
  return AlphaQuantityCaptureSchema.parse({
    ...runtime,
    captured_at: capturedAt,
    block_number: 9_000_000,
    block_hash: "0x" + "a".repeat(64),
    expected_rows: 0,
    received_rows: 0,
    expected_chunks: 1,
    received_chunks: 1,
    completed_at: capturedAt + 1,
    selected: 1,
    ...overrides,
  });
}

export function installAlphaQuantitySchema(db: DatabaseSync) {
  for (const file of [
    "0010_ledger_state.sql",
    "0039_self_stake_snapshot_receipts.sql",
    "0042_alpha_runtime_snapshots.sql",
  ])
    db.exec(
      readFileSync(
        new URL(`../../migrations/d1/${file}`, import.meta.url),
        "utf8",
      ),
    );
}

export function seedSyntheticAlphaPass(
  db: DatabaseSync,
  capturedAt: number,
  overrides: Partial<AlphaQuantityCapture> = {},
) {
  const capture = syntheticAlphaCapture(capturedAt, overrides);
  const runtime = frozen(capture.spec_version);
  db.prepare(
    `INSERT OR IGNORE INTO alpha_runtime_metadata
      (sha256, code_hash, spec_version, scale_hex) VALUES (?, ?, ?, ?)`,
  ).run(
    capture.metadata_sha256,
    capture.code_hash,
    capture.spec_version,
    runtime.metadata_scale_hex,
  );
  db.prepare(
    `INSERT INTO alpha_snapshot_passes
      (captured_at, block_number, block_hash, genesis_hash, spec_version,
       code_hash, metadata_sha256, scanned_legacy, scanned_v2,
       expected_rows, received_rows, expected_chunks, received_chunks, completed_at, selected)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  ).run(
    capture.captured_at,
    capture.block_number,
    capture.block_hash,
    capture.genesis_hash,
    capture.spec_version,
    capture.code_hash,
    capture.metadata_sha256,
    capture.expected_rows,
    capture.expected_rows,
    capture.received_rows,
    capture.expected_chunks,
    capture.received_chunks,
    capture.completed_at,
    capture.selected,
  );
  return capture;
}

/** Synthetic original shares and denominator in one common u64-sized pool.
 * Decimal display amounts are never used to infer the exact amount. */
export function syntheticAlphaPosition(
  coldkey: string,
  hotkey: string,
  netuid: number,
  alphaRao: string,
  capturedAt: number,
) {
  const total = (1n << 64n) - 1n;
  return {
    coldkey,
    hotkey,
    netuid,
    source: "alpha",
    captured_at: capturedAt,
    share_fraction: Number(BigInt(alphaRao)) / Number(total),
    shares: (BigInt(alphaRao) << 64n).toString(),
    alpha_rao: alphaRao,
    alpha_evidence: JSON.stringify({
      share: { legacy_bits: (BigInt(alphaRao) << 64n).toString(), v2: null },
      denominator: { legacy_bits: (total << 64n).toString(), v2: null },
      total_alpha_rao: total.toString(),
      pool_epoch: null,
      member_epoch: null,
    }),
  };
}

export function insertSyntheticAlphaPosition(
  db: DatabaseSync,
  row: ReturnType<typeof syntheticAlphaPosition>,
) {
  db.prepare(
    `INSERT INTO nominator_positions
      (coldkey, hotkey, netuid, source, captured_at, share_fraction, shares, alpha_rao, alpha_evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.coldkey,
    row.hotkey,
    row.netuid,
    row.source,
    row.captured_at,
    row.share_fraction,
    row.shares,
    row.alpha_rao,
    row.alpha_evidence,
  );
  // Keep synthetic completeness counts consistent as a read fixture is assembled.
  db.prepare(
    `UPDATE alpha_snapshot_passes SET expected_rows=expected_rows+1,
      received_rows=received_rows+1, scanned_legacy=scanned_legacy+1 WHERE captured_at=?`,
  ).run(row.captured_at);
}
