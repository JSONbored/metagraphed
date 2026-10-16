import assert from "node:assert/strict";
import { test } from "vitest";
import { ownerCapturePositions } from "../src/owner-capture-positions.ts";
import { ALPHA_GENESIS, ALPHA_RUNTIMES } from "../src/alpha-runtime-identity.ts";
import type { ReadStoreDb } from "../src/read-store.ts";

type Row = Record<string, unknown>;
const position = { coldkey: "owner", hotkey: "validator", share_fraction: 1 };
const capture = (spec: 478 | 479 = 478) => ({
  captured_at: 100,
  block_number: 7,
  block_hash: `0x${"1".repeat(64)}`,
  genesis_hash: ALPHA_GENESIS,
  spec_version: spec,
  code_hash: ALPHA_RUNTIMES[spec].code,
  metadata_sha256: ALPHA_RUNTIMES[spec].metadata,
  expected_rows: 1,
  received_rows: 1,
  expected_chunks: 1,
  received_chunks: 1,
  completed_at: 101,
  selected: 1,
  retained_metadata_sha256: ALPHA_RUNTIMES[spec].metadata,
  retained_code_hash: ALPHA_RUNTIMES[spec].code,
  retained_spec_version: spec,
});
interface ReaderOptions {
  schema?: boolean;
  spec?: 478 | 479;
  selfStake?: boolean;
  nullQuantity?: boolean;
  lateSelfStake?: boolean;
  failure?: boolean;
  race?: boolean;
  rows?: Row[];
}
function reader(options: ReaderOptions = {}): ReadStoreDb {
  let reads = 0;
  let qualificationReads = 0;
  return {
    async first<T>(sql: string) {
      if (options.failure) throw new Error("fixture read failure");
      let value: unknown;
      if (sql.includes("sqlite_master")) {
        const table = { name: "alpha_snapshot_passes" };
        value = options.schema === false ? null : table;
      } else if (sql.includes("AS unqualified")) {
        const late = options.lateSelfStake && qualificationReads++ > 0;
        const unqualified = options.selfStake || options.nullQuantity || late;
        value = { unqualified: unqualified ? 1 : 0 };
      } else {
        value = {
          ...capture(options.spec),
          captured_at: options.race && reads++ > 0 ? 101 : 100,
        };
      }
      return value as T | null;
    },
    async query<T>(sql: string, values: unknown[] = []) {
      assert.match(sql, /FROM alpha_snapshot_rows/);
      assert.deepEqual(values, [23, 100]);
      return (options.rows ?? [position]) as T[];
    },
  };
}
const noLegacy = async (): Promise<Row[]> => {
  throw new Error("canonical evidence must not borrow legacy fractions");
};

test("owner split preserves pre-schema legacy readers", async () => {
  const legacy = async () => [position];
  assert.deepEqual(await ownerCapturePositions(null, 23, legacy), [position]);
  const beforeSchema = reader({ schema: false });
  const result = await ownerCapturePositions(beforeSchema, 23, legacy);
  assert.deepEqual(result, [position]);
});

test("owner split refuses unqualified, shadowed or racing quantities", async () => {
  const valid = await ownerCapturePositions(reader(), 23, noLegacy);
  assert.deepEqual(valid, [position]);
  for (const options of [
    { spec: 479 as const, nullQuantity: true },
    { selfStake: true },
    { lateSelfStake: true },
    { nullQuantity: true },
    { failure: true },
    { race: true },
    ...[null, -0.1, 1.1, Infinity].map((share_fraction) => ({
      rows: [{ ...position, share_fraction }],
    })),
  ]) {
    const result = await ownerCapturePositions(reader(options), 23, noLegacy);
    assert.deepEqual(result, []);
  }
});

test("owner split refuses incomplete reader capabilities", async () => {
  assert.deepEqual(await ownerCapturePositions({}, 23, noLegacy), []);
  const complete = reader();
  const partial = { first: complete.first };
  const result = await ownerCapturePositions(partial, 23, noLegacy);
  assert.deepEqual(result, []);
});
