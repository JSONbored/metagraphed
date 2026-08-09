// The historical hyperparams writer (#5597).
//
// The assertions concentrate on the two properties that differ from the live
// sync path, because those are exactly what a replay gets wrong:
//
//   1. `observed_at` comes from the CALLER (the block's timestamp). The live
//      path stamps Date.now(); doing that here would collapse ~3,697 rows onto
//      one instant and collide on the (netuid, observed_at) key.
//   2. No latest-diff. The live path appends only when the hash differs from
//      the newest recorded row; a replay must be diffed against its own
//      predecessor in time, which the producer already did.
//
// Plus the epoch-millis floor, which is the silent one: a seconds-valued stamp
// inserts perfectly and dates the row to 1970.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  EPOCH_MS_FLOOR,
  HYPERPARAMS_BACKFILL_LANE,
  rejectRow,
  writeHistoricalHyperparams,
  type HistoricalHyperparamsRow,
} from "../src/subnet-hyperparams-backfill.ts";
import { hyperparamsHash } from "../src/subnet-hyperparams-history.ts";
import { formatSubnetHyperparams } from "../src/subnet-hyperparams.ts";

/** A SQL runner that records what it was asked to execute. */
function recorder() {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    sql: {
      async unsafe(text: string, values: unknown[] = []) {
        calls.push({ text, values });
        return undefined;
      },
    },
  };
}

const row = (
  over: Partial<HistoricalHyperparamsRow> = {},
): HistoricalHyperparamsRow => ({
  netuid: 16,
  block_number: 1_929_312,
  observed_at: 1_700_000_000_000,
  hyperparameters: { immunity_period: 8000, tempo: 360 },
  ...over,
});

describe("writeHistoricalHyperparams", () => {
  test("binds the CALLER's observed_at, never a wall-clock now", async () => {
    // The whole reason this module exists rather than reusing the sync path.
    const { sql, calls } = recorder();
    const before = Date.now();
    await writeHistoricalHyperparams(sql, [
      row({ observed_at: 1_700_000_000_000 }),
    ]);
    const [call] = calls;
    assert.equal(call!.values[2], 1_700_000_000_000);
    assert.notEqual(call!.values[2], before);
  });

  test("binds netuid and block_number in the leading positions", async () => {
    const { sql, calls } = recorder();
    await writeHistoricalHyperparams(sql, [row()]);
    assert.equal(calls[0]!.values[0], 16);
    assert.equal(calls[0]!.values[1], 1_929_312);
  });

  test("the statement is idempotent on the natural key", async () => {
    // Migration 0003 declares UNIQUE (netuid, observed_at) as "what the mirror
    // and the backfill conflict on". Verified present in production.
    const { sql, calls } = recorder();
    await writeHistoricalHyperparams(sql, [row()]);
    assert.match(
      calls[0]!.text,
      /ON CONFLICT \(netuid, observed_at\) DO NOTHING/,
    );
  });

  test("does NOT read the latest row first -- the sequence is the diff", async () => {
    // A SELECT here would mean this path re-derived "did it change", which the
    // producer already answered by finding the block in the extrinsic stream.
    const { sql, calls } = recorder();
    await writeHistoricalHyperparams(sql, [
      row(),
      row({ observed_at: 1_700_000_001_000 }),
    ]);
    assert.equal(calls.length, 2);
    for (const call of calls) assert.doesNotMatch(call.text, /SELECT/i);
  });

  test("writes the SAME hash the live writer would for the same input", async () => {
    // Backfilled and live rows must be indistinguishable; a different hash for
    // identical chain state would make them distinguishable in the worst way.
    const { sql, calls } = recorder();
    const hyperparameters = { immunity_period: 8000, tempo: 360 };
    await writeHistoricalHyperparams(sql, [row({ hyperparameters })]);
    const expected = await hyperparamsHash(
      formatSubnetHyperparams(hyperparameters),
    );
    assert.ok(calls[0]!.values.includes(expected));
  });

  test("every column it binds comes from the shared history column list", async () => {
    const { sql, calls } = recorder();
    await writeHistoricalHyperparams(sql, [row()]);
    const columns = /INSERT INTO subnet_hyperparams_history \(([^)]*)\)/
      .exec(calls[0]!.text)![1]!
      .split(",")
      .map((c) => c.trim());
    assert.equal(columns[0], "netuid");
    assert.equal(columns[1], "block_number");
    assert.equal(columns[2], "observed_at");
    assert.ok(columns.includes("hyperparams_hash"));
    // One placeholder per column, or the binds silently shift by one.
    assert.equal(calls[0]!.values.length, columns.length);
  });

  test("a rejected row costs that row, not the run -- and is reported", async () => {
    const { sql, calls } = recorder();
    const result = await writeHistoricalHyperparams(sql, [
      row({ netuid: -1 }),
      row({ netuid: 7 }),
    ]);
    assert.equal(result.attempted, 1, "the good row still went");
    assert.equal(calls.length, 1);
    assert.deepEqual(result.rejected, [{ netuid: -1, reason: "netuid" }]);
  });
});

describe("rejectRow", () => {
  test("a SECONDS-valued observed_at is refused", () => {
    // The silent one: it inserts fine and dates the row to 1970, in a table
    // no later pass can revise. #9782 is this exact bug.
    assert.equal(
      rejectRow(row({ observed_at: 1_700_000_000 })),
      "observed_at_not_millis",
    );
    assert.equal(rejectRow(row({ observed_at: EPOCH_MS_FLOOR })), null);
  });

  test("a missing block is refused -- the producer found the row BY its block", () => {
    assert.equal(rejectRow(row({ block_number: 0 })), "block_number");
    assert.equal(
      rejectRow(row({ block_number: undefined as unknown as number })),
      "block_number",
    );
  });

  test("a non-integer netuid is refused", () => {
    assert.equal(rejectRow(row({ netuid: 1.5 })), "netuid");
  });

  test("missing hyperparameters are refused", () => {
    assert.equal(
      rejectRow(row({ hyperparameters: undefined as unknown as never })),
      "hyperparameters",
    );
  });

  test("a well-formed row passes", () => {
    assert.equal(rejectRow(row()), null);
  });

  test("the lane name is stable", () => {
    assert.equal(HYPERPARAMS_BACKFILL_LANE, "subnet-hyperparams-backfill");
  });
});
