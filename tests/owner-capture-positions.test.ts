import assert from "node:assert/strict";
import { test } from "vitest";
import { ownerCapturePositions } from "../src/owner-capture-positions.ts";
import { ALPHA_GENESIS, ALPHA_RUNTIMES } from "../src/alpha-runtime-identity.ts";
import type { OptionalRowQuerier, OptionalRowReader } from "../src/read-store.ts";

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
function reader(
  options: {
    schema?: boolean;
    spec?: 478 | 479;
    selfStake?: boolean;
    failure?: boolean;
    race?: boolean;
    rows?: Row[];
  } = {},
): OptionalRowReader & OptionalRowQuerier {
  let reads = 0;
  return {
    async first<T>(sql: string) {
      if (options.failure) throw new Error("fixture read failure");
      let value: unknown;
      if (sql.includes("sqlite_master"))
        value = options.schema === false ? null : { name: "alpha_snapshot_passes" };
      else if (sql.includes("source='self-stake'"))
        value = options.selfStake ? { coldkey: "other" } : null;
      else {
        value = capture(options.race && reads++ > 0 ? 479 : options.spec);
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
  assert.deepEqual(
    await ownerCapturePositions(reader({ schema: false }), 23, legacy),
    [position],
  );
});

test("owner split selects exact canonical rows and refuses unqualified, shadowed or racing quantities", async () => {
  assert.deepEqual(await ownerCapturePositions(reader(), 23, noLegacy), [position]);
  for (const options of [
    { spec: 479 as const },
    { selfStake: true },
    { failure: true },
    { race: true },
    ...[null, -0.1, 1.1, Infinity].map((share_fraction) => ({
      rows: [{ ...position, share_fraction }],
    })),
  ])
    assert.deepEqual(
      await ownerCapturePositions(reader(options), 23, noLegacy),
      [],
    );
});

test("owner split refuses incomplete reader capabilities", async () => {
  assert.deepEqual(await ownerCapturePositions({}, 23, noLegacy), []);
  const complete = reader();
  assert.deepEqual(
    await ownerCapturePositions({ first: complete.first }, 23, noLegacy),
    [],
  );
});
