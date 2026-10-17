import assert from "node:assert/strict";
import { test } from "vitest";
import {
  alphaCaptureState,
  alphaCaptureStateFromOwner,
  alphaPositionsUnqualified,
} from "../src/alpha-capture-reader.ts";
import {
  ALPHA_GENESIS,
  ALPHA_RUNTIMES,
} from "../src/alpha-runtime-identity.ts";
import { isPostgresReadStore, pgReadStore } from "../src/read-store.ts";

const capture = (spec: 454 | 478 | 479 = 478) => ({
  captured_at: 1_700_000_000_000,
  block_number: 100,
  block_hash: "0x" + "a".repeat(64),
  genesis_hash: ALPHA_GENESIS,
  spec_version: spec,
  code_hash: ALPHA_RUNTIMES[spec].code,
  metadata_sha256: ALPHA_RUNTIMES[spec].metadata,
  expected_rows: 1,
  received_rows: 1,
  expected_chunks: 1,
  received_chunks: 1,
  completed_at: 1_700_000_000_001,
  selected: 1,
  retained_metadata_sha256: ALPHA_RUNTIMES[spec].metadata,
  retained_code_hash: ALPHA_RUNTIMES[spec].code,
  retained_spec_version: spec,
});

function reader(row: unknown, available = true) {
  return {
    async first(sql: string) {
      if (sql.includes("sqlite_master"))
        return available ? { name: "alpha_snapshot_passes" } : null;
      // The newest canonical owner must be selected before its metadata join.
      assert.match(sql, /FROM \(SELECT \* FROM alpha_snapshot_passes/);
      assert.match(
        sql,
        /ORDER BY block_number DESC,captured_at DESC LIMIT 1\) p/,
      );
      assert.match(sql, /LEFT JOIN alpha_runtime_metadata/);
      return row;
    },
  };
}

test("old schema and empty new schema remain distinct without inventing a capture", async () => {
  assert.deepEqual(await alphaCaptureState(reader(null, false)), {
    available: false,
    capture: null,
  });
  assert.deepEqual(await alphaCaptureState(reader(null)), {
    available: true,
    capture: null,
  });
});

test("only exact known arithmetic adapters qualify the selected canonical capture", async () => {
  for (const spec of [454, 478, 479] as const) {
    const state = await alphaCaptureState(reader(capture(spec)));
    assert.equal(state.capture?.quantityQualified, true);
    assert.equal(state.capture?.spec_version, spec);
  }
  const state = await alphaCaptureState(
    reader({ ...capture(479), spec_version: 480, retained_spec_version: 480 }),
  );
  assert.equal(state.capture?.spec_version, 480);
  assert.equal(state.capture?.quantityQualified, false);
});

test("missing or mismatched newest metadata cannot borrow an older qualified quantity", async () => {
  for (const override of [
    {
      retained_metadata_sha256: null,
      retained_code_hash: null,
      retained_spec_version: null,
    },
    { retained_code_hash: "0x" + "b".repeat(64) },
    { retained_spec_version: 454 },
    { metadata_sha256: "b".repeat(64) },
    { code_hash: "0x" + "b".repeat(64) },
    { genesis_hash: "0x" + "b".repeat(64) },
    { received_rows: 0 },
    { received_chunks: 2 },
    { completed_at: 1 },
  ]) {
    const state = await alphaCaptureState(
      reader({ ...capture(), ...override }),
    );
    assert.equal(state.available, true);
    assert.equal(state.capture?.captured_at, capture().captured_at);
    assert.equal(state.capture?.quantityQualified, false);
  }
});

test("malformed latest canonical identity declines rather than falling back", async () => {
  for (const override of [
    { captured_at: -1 },
    { block_hash: "invalid" },
    { selected: 0 },
    { completed_at: null },
  ])
    assert.deepEqual(
      await alphaCaptureState(reader({ ...capture(), ...override })),
      {
        available: true,
        capture: null,
      },
    );
});

test("unavailable or failed owner reads cannot downgrade to legacy schema", async () => {
  await assert.rejects(alphaCaptureState(undefined), /unavailable/);
  for (const failSchema of [false, true]) {
    await assert.rejects(
      alphaCaptureState({
        async first(sql) {
          if (!failSchema && sql.includes("sqlite_master"))
            return { name: "alpha_snapshot_passes" };
          throw new Error("owner read failed");
        },
      }),
      /owner read failed/,
    );
  }
});

test("Neon handles skip native schema discovery while partial native ownership fails closed", async () => {
  const pg = pgReadStore("postgres://unused.invalid/fixture");
  assert.equal(isPostgresReadStore(pg), true);
  for (const value of [undefined, null, false, {}, reader(null)])
    assert.equal(isPostgresReadStore(value), false);
  assert.deepEqual(await alphaCaptureState(pg), {
    available: false,
    capture: null,
  });
  assert.deepEqual(await alphaCaptureStateFromOwner({}), {
    available: false,
    capture: null,
  });
  await assert.rejects(
    alphaCaptureStateFromOwner({ D1_STATE_TABLES: "alpha_snapshot_rows" }),
    /requires its nominator_positions owner/,
  );
  await assert.rejects(
    alphaCaptureStateFromOwner({ D1_STATE_TABLES: "nominator_positions" }),
    /spans D1 and Neon/,
  );
  await assert.rejects(
    alphaCaptureStateFromOwner({
      D1_STATE_TABLES:
        "nominator_positions,nominator_positions_passes,nominator_scan_receipts",
    }),
    /unbound/,
  );
});

test("scoped position qualification bounds both sources and treats missing proof as unqualified", async () => {
  for (const scope of [
    undefined,
    { column: "coldkey" as const, value: "alice" },
    { column: "hotkey" as const, value: "hot" },
    { column: "netuid" as const, value: 23 },
  ]) {
    for (const result of [null, {}, { unqualified: 1 }, { unqualified: 0 }]) {
      const unqualified = await alphaPositionsUnqualified(
        {
          async first(sql, values) {
            assert.match(sql, /source='self-stake'/);
            assert.match(sql, /alpha_rao IS NULL/);
            assert.deepEqual(
              values,
              scope ? [scope.value, 1, scope.value] : [1],
            );
            if (scope)
              assert.equal(sql.split(`AND ${scope.column}=?`).length, 3);
            return result;
          },
        },
        1,
        scope,
      );
      assert.equal(
        unqualified,
        !result || !("unqualified" in result) || result.unqualified !== 0,
      );
    }
  }
  for (const at of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(alphaPositionsUnqualified(reader(null), at), /scope/);
  await assert.rejects(alphaPositionsUnqualified({}, 1), /scope/);
  await assert.rejects(
    alphaPositionsUnqualified(reader(null), 1, {
      column: "invalid" as "coldkey",
      value: "ignored",
    }),
    /scope/,
  );
});
